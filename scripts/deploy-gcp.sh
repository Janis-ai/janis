#!/usr/bin/env bash
# Deploy Janis to Cloud Run (project jottogame, us-east1).
# Builds the image via Cloud Build, then rolls out a new revision.
# Env vars come from apps/api/.env plus SESSION_SECRET (preserved from the
# running service on redeploys — do not regenerate or sessions log out).
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=jottogame REGION=us-east1 SERVICE=janis-api
BASE="https://janis-api-1090022080491.${REGION}.run.app"

gcloud builds submit --config cloudbuild.yaml --project "$PROJECT"

python3 - <<PY
import yaml, subprocess, secrets
envs = {}
for line in open('apps/api/.env'):
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, v = line.split('=', 1)
        envs[k.strip()] = v.strip()
envs['PGLITE_DIR'] = '/app/data/pglite'
envs['API_ORIGIN'] = envs['WEB_ORIGIN'] = "$BASE"
if 'SESSION_SECRET' not in envs:
    envs['SESSION_SECRET'] = secrets.token_urlsafe(32)
yaml.safe_dump(envs, open('/tmp/janis-env.yaml', 'w'))
PY

gcloud run deploy "$SERVICE" --image "gcr.io/$PROJECT/$SERVICE" \
  --region "$REGION" --project "$PROJECT" --allow-unauthenticated \
  --max-instances 1 --memory 1Gi \
  --add-volume name=data,type=cloud-storage,bucket=janis-data-jottogame \
  --add-volume-mount volume=data,mount-path=/app/data \
  --env-vars-file /tmp/janis-env.yaml
echo "Deployed: $BASE"
