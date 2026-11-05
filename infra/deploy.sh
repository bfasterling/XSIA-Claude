#!/usr/bin/env bash
# =============================================================================
# XSIA Claude — Construye y despliega backend (Cloud Run: api + worker) y frontend (Firebase Hosting)
# Uso:  PROJECT_ID=mi-proyecto REGION=us-central1 ./infra/deploy.sh [backend|frontend|all]
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

: "${PROJECT_ID:?Define PROJECT_ID}"
REGION="${REGION:-us-central1}"
TARGET="${1:-all}"
DATA_BUCKET="${DATA_BUCKET:-${PROJECT_ID}-xsia-data}"
MEDIA_BUCKET="${MEDIA_BUCKET:-${PROJECT_ID}-xsia-media}"
RUN_SA="xsia-run@${PROJECT_ID}.iam.gserviceaccount.com"
TASKS_SA="xsia-tasks@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/xsia/xsia-backend:$(date +%Y%m%d-%H%M%S)"
CLAUDE_PROVIDER="${CLAUDE_PROVIDER:-anthropic}"
CLAUDE_MODEL_CHAT="${CLAUDE_MODEL_CHAT:-claude-sonnet-5-5}"
CLAUDE_MODEL_FAST="${CLAUDE_MODEL_FAST:-claude-haiku-5-5}"
HOSTING_URL="${HOSTING_URL:-https://${PROJECT_ID}.web.app}"

gcloud config set project "${PROJECT_ID}" >/dev/null

COMMON_ENV="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GCP_REGION=${REGION},GCS_BUCKET=${DATA_BUCKET},GCS_MEDIA_BUCKET=${MEDIA_BUCKET},GCS_MEDIA_PUBLIC=true,\
CLAUDE_PROVIDER=${CLAUDE_PROVIDER},CLAUDE_MODEL_CHAT=${CLAUDE_MODEL_CHAT},CLAUDE_MODEL_FAST=${CLAUDE_MODEL_FAST},\
EMBEDDINGS_PROVIDER=${EMBEDDINGS_PROVIDER:-vertex},EMBEDDINGS_MODEL=${EMBEDDINGS_MODEL:-text-multilingual-embedding-002},EMBEDDING_DIM=${EMBEDDING_DIM:-768},\
TASKS_LOCATION=${REGION},TASKS_QUEUE=xsia-default,TASKS_QUEUE_SEND=xsia-recovery-send,TASKS_INVOKER_SA=${TASKS_SA},\
DEFAULT_TIMEZONE=${DEFAULT_TIMEZONE:-America/Mexico_City},PUBLIC_BASE_URL=${HOSTING_URL},GRAPH_API_VERSION=${GRAPH_API_VERSION:-v23.0}"
SECRETS="ANTHROPIC_API_KEY=anthropic-api-key:latest,META_APP_SECRET=meta-app-secret:latest,META_VERIFY_TOKEN=meta-verify-token:latest,TASKS_SHARED_SECRET=tasks-shared-secret:latest,GOOGLE_MAPS_API_KEY=google-maps-api-key:latest"

if [[ "${TARGET}" == "all" || "${TARGET}" == "backend" ]]; then
  echo "▶ Construyendo imagen ${IMAGE}…"
  gcloud builds submit backend --tag "${IMAGE}"

  echo "▶ Desplegando worker (privado)…"
  gcloud run deploy xsia-worker --image "${IMAGE}" --region "${REGION}" \
    --service-account "${RUN_SA}" --no-allow-unauthenticated \
    --cpu 1 --memory 1Gi --timeout 900 --concurrency 20 --min-instances 0 --max-instances 10 \
    --set-env-vars "ROLE=worker,${COMMON_ENV}" --set-secrets "${SECRETS}"
  WORKER_URL=$(gcloud run services describe xsia-worker --region "${REGION}" --format='value(status.url)')
  gcloud run services add-iam-policy-binding xsia-worker --region "${REGION}" \
    --member="serviceAccount:${TASKS_SA}" --role=roles/run.invoker >/dev/null

  echo "▶ Desplegando API (pública)…"
  API_URL_GUESS=$(gcloud run services describe xsia-api --region "${REGION}" --format='value(status.url)' 2>/dev/null || true)
  gcloud run deploy xsia-api --image "${IMAGE}" --region "${REGION}" \
    --service-account "${RUN_SA}" --allow-unauthenticated \
    --cpu 1 --memory 1Gi --timeout 300 --concurrency 80 --min-instances "${API_MIN_INSTANCES:-1}" --max-instances 20 --no-cpu-throttling \
    --set-env-vars "ROLE=api,${COMMON_ENV},WORKER_URL=${WORKER_URL},API_BASE_URL=${API_URL_GUESS:-pending},ADMIN_EMAILS=${ADMIN_EMAILS:-},CORS_ORIGINS=${CORS_ORIGINS:-*}" \
    --set-secrets "${SECRETS}"
  API_URL=$(gcloud run services describe xsia-api --region "${REGION}" --format='value(status.url)')
  if [[ "${API_URL_GUESS}" != "${API_URL}" ]]; then
    gcloud run services update xsia-api --region "${REGION}" --update-env-vars "API_BASE_URL=${API_URL}" >/dev/null
  fi
  # El worker conoce su propia URL para encolar tareas de segundo nivel
  gcloud run services update xsia-worker --region "${REGION}" --update-env-vars "WORKER_URL=${WORKER_URL},API_BASE_URL=${API_URL}" >/dev/null
  echo "  API: ${API_URL}"
fi

if [[ "${TARGET}" == "all" || "${TARGET}" == "frontend" ]]; then
  echo "▶ Construyendo frontend…"
  API_URL=$(gcloud run services describe xsia-api --region "${REGION}" --format='value(status.url)')
  if [[ ! -f frontend/.env.production ]]; then
    echo "  ⚠ Falta frontend/.env.production (configuración web de Firebase). Copia frontend/.env.example y complétalo."
    exit 1
  fi
  ( cd frontend && npm install && VITE_API_BASE_URL="${VITE_API_BASE_URL:-${API_URL}}" npm run build )
  echo "▶ Desplegando Firebase Hosting + reglas e índices de Firestore…"
  npx --yes firebase-tools@13 deploy --project "${PROJECT_ID}" --only hosting,firestore:rules,firestore:indexes
fi

echo "✅ Despliegue completado."
