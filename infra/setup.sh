#!/usr/bin/env bash
# =============================================================================
# XSIA Claude — Aprovisionamiento inicial en Google Cloud (ejecutar una vez)
# Requiere: gcloud autenticado como Owner del proyecto, firebase-tools, Node 20
# Uso:  PROJECT_ID=mi-proyecto REGION=us-central1 ADMIN_EMAILS=yo@empresa.com ./infra/setup.sh
# =============================================================================
set -euo pipefail

: "${PROJECT_ID:?Define PROJECT_ID}"
REGION="${REGION:-us-central1}"
ADMIN_EMAILS="${ADMIN_EMAILS:-}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-nam5}"
DATA_BUCKET="${DATA_BUCKET:-${PROJECT_ID}-xsia-data}"
MEDIA_BUCKET="${MEDIA_BUCKET:-${PROJECT_ID}-xsia-media}"
AR_REPO="xsia"
RUN_SA="xsia-run@${PROJECT_ID}.iam.gserviceaccount.com"
TASKS_SA="xsia-tasks@${PROJECT_ID}.iam.gserviceaccount.com"
EMBEDDING_DIM="${EMBEDDING_DIM:-768}"

echo "▶ Proyecto: ${PROJECT_ID} · Región: ${REGION}"
gcloud config set project "${PROJECT_ID}" >/dev/null
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')

echo "▶ Habilitando APIs…"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com cloudtasks.googleapis.com cloudscheduler.googleapis.com \
  secretmanager.googleapis.com aiplatform.googleapis.com storage.googleapis.com \
  texttospeech.googleapis.com speech.googleapis.com iam.googleapis.com \
  firebase.googleapis.com identitytoolkit.googleapis.com geocoding-backend.googleapis.com

echo "▶ Firestore (modo nativo)…"
if ! gcloud firestore databases describe --database='(default)' >/dev/null 2>&1; then
  gcloud firestore databases create --location="${FIRESTORE_LOCATION}" --type=firestore-native
fi

echo "▶ Buckets de Cloud Storage…"
gcloud storage buckets describe "gs://${DATA_BUCKET}" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://${DATA_BUCKET}" --location="${REGION}" --uniform-bucket-level-access
gcloud storage buckets describe "gs://${MEDIA_BUCKET}" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://${MEDIA_BUCKET}" --location="${REGION}" --uniform-bucket-level-access
# Imágenes de la librería: lectura pública (necesario para mostrarlas en el chat y enviarlas por WhatsApp)
gcloud storage buckets add-iam-policy-binding "gs://${MEDIA_BUCKET}" --member=allUsers --role=roles/storage.objectViewer >/dev/null

echo "▶ Cuentas de servicio…"
gcloud iam service-accounts describe "${RUN_SA}" >/dev/null 2>&1 || \
  gcloud iam service-accounts create xsia-run --display-name="XSIA Claude runtime"
gcloud iam service-accounts describe "${TASKS_SA}" >/dev/null 2>&1 || \
  gcloud iam service-accounts create xsia-tasks --display-name="XSIA Claude tasks invoker"

for ROLE in roles/datastore.user roles/cloudtasks.enqueuer roles/aiplatform.user roles/secretmanager.secretAccessor \
            roles/logging.logWriter roles/firebaseauth.viewer roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="serviceAccount:${RUN_SA}" --role="${ROLE}" --condition=None >/dev/null
done
gcloud storage buckets add-iam-policy-binding "gs://${DATA_BUCKET}" --member="serviceAccount:${RUN_SA}" --role=roles/storage.objectAdmin >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${MEDIA_BUCKET}" --member="serviceAccount:${RUN_SA}" --role=roles/storage.objectAdmin >/dev/null
# El runtime crea tareas con token OIDC de xsia-tasks → necesita actuar como esa cuenta
gcloud iam service-accounts add-iam-policy-binding "${TASKS_SA}" --member="serviceAccount:${RUN_SA}" --role=roles/iam.serviceAccountUser >/dev/null
# Cloud Scheduler usa xsia-tasks para invocar el worker
gcloud iam service-accounts add-iam-policy-binding "${TASKS_SA}" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com" --role=roles/iam.serviceAccountTokenCreator >/dev/null || true
# Cloud Build despliega a Cloud Run usando la cuenta de runtime
CB_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
for ROLE in roles/run.admin roles/iam.serviceAccountUser roles/artifactregistry.writer; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="serviceAccount:${CB_SA}" --role="${ROLE}" --condition=None >/dev/null || true
done

echo "▶ Secretos (Secret Manager)…"
create_secret () {
  local NAME="$1" VALUE="$2"
  if ! gcloud secrets describe "${NAME}" >/dev/null 2>&1; then
    printf '%s' "${VALUE}" | gcloud secrets create "${NAME}" --data-file=- --replication-policy=automatic >/dev/null
    echo "  · ${NAME} creado"
  else
    echo "  · ${NAME} ya existe (para cambiarlo: gcloud secrets versions add ${NAME} --data-file=-)"
  fi
}
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then read -r -s -p "  ANTHROPIC_API_KEY (Enter para omitir si usarás Claude en Vertex): " ANTHROPIC_API_KEY; echo; fi
create_secret anthropic-api-key "${ANTHROPIC_API_KEY:-PENDIENTE}"
if [[ -z "${META_APP_SECRET:-}" ]]; then read -r -s -p "  META_APP_SECRET (Meta App → Configuración básica; Enter = después): " META_APP_SECRET; echo; fi
create_secret meta-app-secret "${META_APP_SECRET:-PENDIENTE}"
create_secret meta-verify-token "${META_VERIFY_TOKEN:-$(openssl rand -hex 16)}"
create_secret tasks-shared-secret "$(openssl rand -hex 24)"
create_secret google-maps-api-key "${GOOGLE_MAPS_API_KEY:-NONE}"

echo "▶ Artifact Registry…"
gcloud artifacts repositories describe "${AR_REPO}" --location="${REGION}" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "${AR_REPO}" --repository-format=docker --location="${REGION}"

echo "▶ Colas de Cloud Tasks…"
gcloud tasks queues describe xsia-default --location="${REGION}" >/dev/null 2>&1 || \
  gcloud tasks queues create xsia-default --location="${REGION}" --max-concurrent-dispatches=20 --max-attempts=8 --min-backoff=5s --max-backoff=300s
gcloud tasks queues describe xsia-recovery-send --location="${REGION}" >/dev/null 2>&1 || \
  gcloud tasks queues create xsia-recovery-send --location="${REGION}" --max-dispatches-per-second=5 --max-concurrent-dispatches=10 --max-attempts=3 --min-backoff=30s

echo "▶ Índice vectorial de Firestore (RAG, dimensión ${EMBEDDING_DIM})…"
gcloud firestore indexes composite create --collection-group=chunks --query-scope=COLLECTION \
  --field-config=field-path=agentId,order=ascending \
  --field-config="field-path=embedding,vector-config={\"dimension\":\"${EMBEDDING_DIM}\",\"flat\":\"{}\"}" --async 2>/dev/null || echo "  · (índice ya existente)"

echo "▶ Primer despliegue…"
PROJECT_ID="${PROJECT_ID}" REGION="${REGION}" ADMIN_EMAILS="${ADMIN_EMAILS}" DATA_BUCKET="${DATA_BUCKET}" MEDIA_BUCKET="${MEDIA_BUCKET}" \
  "$(dirname "$0")/deploy.sh"

WORKER_URL=$(gcloud run services describe xsia-worker --region="${REGION}" --format='value(status.url)')
echo "▶ Cloud Scheduler: ciclo de Recovery cada minuto…"
if gcloud scheduler jobs describe xsia-recovery-tick --location="${REGION}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http xsia-recovery-tick --location="${REGION}" --schedule="* * * * *" \
    --uri="${WORKER_URL}/tasks/recovery-tick" --http-method=POST --message-body='{}' \
    --oidc-service-account-email="${TASKS_SA}" --oidc-token-audience="${WORKER_URL}" \
    --update-headers="Content-Type=application/json,X-Tasks-Secret=$(gcloud secrets versions access latest --secret=tasks-shared-secret)" >/dev/null
else
  gcloud scheduler jobs create http xsia-recovery-tick --location="${REGION}" --schedule="* * * * *" \
    --uri="${WORKER_URL}/tasks/recovery-tick" --http-method=POST --message-body='{}' \
    --oidc-service-account-email="${TASKS_SA}" --oidc-token-audience="${WORKER_URL}" \
    --headers="Content-Type=application/json,X-Tasks-Secret=$(gcloud secrets versions access latest --secret=tasks-shared-secret)" >/dev/null
fi

API_URL=$(gcloud run services describe xsia-api --region="${REGION}" --format='value(status.url)')
echo ""
echo "✅ Infraestructura lista."
echo "   API:              ${API_URL}"
echo "   Worker (privado): ${WORKER_URL}"
echo "   Webhook WhatsApp: ${API_URL}/webhooks/whatsapp"
echo "   Verify token:     $(gcloud secrets versions access latest --secret=meta-verify-token)"
echo "   Hosting:          https://${PROJECT_ID}.web.app"
