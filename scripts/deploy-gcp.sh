#!/usr/bin/env bash
# Deploy Janis to Cloud Run (project janis-prod-mn, us-east1).
# Builds the image via Cloud Build, then rolls out a new revision.
#
# Env vars come from apps/api/.env, overlaid by apps/api/.env.production
# (gitignored — prod-only values like DATABASE_URL live there).
# If DATABASE_URL is set the app uses real Postgres and the PGlite/GCS
# volume is removed; otherwise it falls back to PGlite on a FUSE-mounted
# bucket (single-writer: keep --max-instances 1 in that mode).
# DATABASE_URL is stored in Secret Manager (janis-database-url), never in
# plain env vars. SESSION_SECRET is preserved from the running service on
# redeploys — do not regenerate or sessions log out.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=janis-prod-mn REGION=us-east1 SERVICE=janis-api
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
export PROJECT PROJECT_NUMBER BASE
BASE="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"

gcloud builds submit --config cloudbuild.yaml --project "$PROJECT"

python3 - <<'PY'
import yaml, subprocess, secrets, os

PROJECT = os.environ['PROJECT']
PROJECT_NUMBER = os.environ['PROJECT_NUMBER']

def read_env(path):
    envs = {}
    try:
        for line in open(path):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                envs[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return envs

envs = read_env('apps/api/.env')
envs.update(read_env('apps/api/.env.production'))

db_url = envs.pop('DATABASE_URL', '')
if db_url:
    envs.pop('PGLITE_DIR', None)
    r = subprocess.run(
        ['gcloud', 'secrets', 'describe', 'janis-database-url', '--project', PROJECT],
        capture_output=True)
    if r.returncode != 0:
        subprocess.run(['gcloud', 'secrets', 'create', 'janis-database-url',
                        '--project', PROJECT, '--replication-policy', 'automatic',
                        '--data-file', '-'], input=db_url.encode(), check=True)
    else:
        subprocess.run(['gcloud', 'secrets', 'versions', 'add', 'janis-database-url',
                        '--project', PROJECT, '--data-file', '-'],
                       input=db_url.encode(), check=True)
    # Runtime service account (default compute SA) needs read access
    subprocess.run(['gcloud', 'secrets', 'add-iam-policy-binding', 'janis-database-url',
                    '--project', PROJECT,
                    '--member', f'serviceAccount:{PROJECT_NUMBER}-compute@developer.gserviceaccount.com',
                    '--role', 'roles/secretmanager.secretAccessor'],
                   capture_output=True)
else:
    envs['PGLITE_DIR'] = '/app/data/pglite'

# Attachments write to the FUSE bucket in both modes — container-local
# storage would lose them on every redeploy/instance recycle.
envs.setdefault('UPLOAD_DIR', '/app/data/uploads')

# PUBLIC_ORIGIN (set in .env.production once the custom domain is live)
# canonicalizes links/OAuth callbacks to the branded domain; otherwise the
# raw run.app URL is used.
public_origin = envs.pop('PUBLIC_ORIGIN', '') or os.environ['BASE']
envs['API_ORIGIN'] = envs['WEB_ORIGIN'] = public_origin
if 'SESSION_SECRET' not in envs:
    envs['SESSION_SECRET'] = secrets.token_urlsafe(32)
yaml.safe_dump(envs, open('/tmp/janis-env.yaml', 'w'))
print('DATABASE_URL' if db_url else 'PGlite', 'mode')
PY

# DATABASE_URL mode: no volume. PGlite mode: FUSE bucket for persistence.
if python3 -c "import yaml; exit(0 if 'PGLITE_DIR' in yaml.safe_load(open('/tmp/janis-env.yaml')) else 1)"; then
  gcloud run deploy "$SERVICE" --image "gcr.io/$PROJECT/$SERVICE" \
    --region "$REGION" --project "$PROJECT" --allow-unauthenticated \
    --max-instances 1 --memory 1Gi --no-cpu-throttling \
    --add-volume name=data,type=cloud-storage,bucket=janis-data-$PROJECT \
    --add-volume-mount volume=data,mount-path=/app/data \
    --env-vars-file /tmp/janis-env.yaml
else
  gcloud run deploy "$SERVICE" --image "gcr.io/$PROJECT/$SERVICE" \
    --region "$REGION" --project "$PROJECT" --allow-unauthenticated \
    --memory 1Gi --no-cpu-throttling \
    --add-volume name=data,type=cloud-storage,bucket=janis-data-$PROJECT \
    --add-volume-mount volume=data,mount-path=/app/data \
    --update-secrets "DATABASE_URL=janis-database-url:latest" \
    --env-vars-file /tmp/janis-env.yaml
fi
echo "Deployed: $BASE"
