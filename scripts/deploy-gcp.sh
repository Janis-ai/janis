#!/usr/bin/env bash
# Deploy Janis to Cloud Run (project jottogame, us-east1).
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

PROJECT=jottogame REGION=us-east1 SERVICE=janis-api
BASE="https://janis-api-1090022080491.${REGION}.run.app"

gcloud builds submit --config cloudbuild.yaml --project "$PROJECT"

python3 - <<'PY'
import yaml, subprocess, secrets

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
        ['gcloud', 'secrets', 'describe', 'janis-database-url', '--project', 'jottogame'],
        capture_output=True)
    if r.returncode != 0:
        subprocess.run(['gcloud', 'secrets', 'create', 'janis-database-url',
                        '--project', 'jottogame', '--replication-policy', 'automatic',
                        '--data-file', '-'], input=db_url.encode(), check=True)
    else:
        subprocess.run(['gcloud', 'secrets', 'versions', 'add', 'janis-database-url',
                        '--project', 'jottogame', '--data-file', '-'],
                       input=db_url.encode(), check=True)
    # Runtime service account (default compute SA) needs read access
    subprocess.run(['gcloud', 'secrets', 'add-iam-policy-binding', 'janis-database-url',
                    '--project', 'jottogame',
                    '--member', 'serviceAccount:1090022080491-compute@developer.gserviceaccount.com',
                    '--role', 'roles/secretmanager.secretAccessor'],
                   capture_output=True)
else:
    envs['PGLITE_DIR'] = '/app/data/pglite'

envs['API_ORIGIN'] = envs['WEB_ORIGIN'] = 'https://janis-api-1090022080491.us-east1.run.app'
if 'SESSION_SECRET' not in envs:
    envs['SESSION_SECRET'] = secrets.token_urlsafe(32)
yaml.safe_dump(envs, open('/tmp/janis-env.yaml', 'w'))
print('DATABASE_URL' if db_url else 'PGlite', 'mode')
PY

# DATABASE_URL mode: no volume. PGlite mode: FUSE bucket for persistence.
if python3 -c "import yaml; exit(0 if 'PGLITE_DIR' in yaml.safe_load(open('/tmp/janis-env.yaml')) else 1)"; then
  gcloud run deploy "$SERVICE" --image "gcr.io/$PROJECT/$SERVICE" \
    --region "$REGION" --project "$PROJECT" --allow-unauthenticated \
    --max-instances 1 --memory 1Gi \
    --add-volume name=data,type=cloud-storage,bucket=janis-data-jottogame \
    --add-volume-mount volume=data,mount-path=/app/data \
    --env-vars-file /tmp/janis-env.yaml
else
  gcloud run deploy "$SERVICE" --image "gcr.io/$PROJECT/$SERVICE" \
    --region "$REGION" --project "$PROJECT" --allow-unauthenticated \
    --memory 1Gi \
    --clear-volumes --clear-volume-mounts \
    --update-secrets "DATABASE_URL=janis-database-url:latest" \
    --env-vars-file /tmp/janis-env.yaml
fi
echo "Deployed: $BASE"
