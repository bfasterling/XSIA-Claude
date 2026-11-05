# Guía de despliegue en Google Cloud

Tiempo estimado: 45–60 minutos la primera vez.

## 0. Requisitos

- Un proyecto de GCP con facturación activa, y tu usuario como **Owner**.
- Instalado en tu computadora:
  - Google Cloud SDK (`gcloud`). Ejecuta `gcloud auth login` y `gcloud auth application-default login`.
  - Node.js 20 o superior y `npm`.
  - Firebase CLI: `npm i -g firebase-tools`, luego `firebase login`.
- Una llave de **Anthropic** (console.anthropic.com), **o bien** Claude habilitado en Vertex AI Model Garden (ver paso 7).
- Para WhatsApp: una app de Meta con el producto WhatsApp, una cuenta de WhatsApp Business, un número y un **token de System User** permanente.
- Opcional: una llave de **Google Maps Geocoding API**, para buscar distribuidores por cercanía.

```bash
git clone https://github.com/bfasterling/xsia-claude.git
cd xsia-claude
```

## 1. Vincular Firebase al proyecto

1. Abre https://console.firebase.google.com → **Agregar proyecto** → elige tu proyecto de GCP existente.
2. En **Authentication → Método de acceso**, habilita **Correo/contraseña** y/o **Google**.
3. En **Authentication → Configuración → Dominios autorizados**, agrega tu dominio personalizado si vas a usar uno.
4. En **Configuración del proyecto → Tus apps**, agrega una **App web** y copia su configuración.
5. Crea `frontend/.env.production`:

```bash
cp frontend/.env.example frontend/.env.production
# Completa VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID, VITE_FIREBASE_APP_ID
# Deja VITE_API_BASE_URL vacío: deploy.sh lo completa con la URL de Cloud Run
```

6. En `.firebaserc`, reemplaza `TU-PROYECTO-GCP` por tu ID de proyecto.
7. Si usas una región distinta de `us-central1`, cámbiala también en `firebase.json` (rewrites).

## 2. Aprovisionar e instalar todo con un comando

```bash
export PROJECT_ID=mi-proyecto
export REGION=us-central1
export ADMIN_EMAILS=tu-correo@empresa.com        # se convierte en administrador al iniciar sesión
export ANTHROPIC_API_KEY=sk-ant-...              # o se te pedirá
export GOOGLE_MAPS_API_KEY=AIza...               # opcional
./infra/setup.sh
```

El script hace lo siguiente:

- habilita las APIs;
- crea la base de Firestore nativa, los buckets (datos privado y medios público) y las cuentas de servicio `xsia-run` y `xsia-tasks` con permisos mínimos;
- crea los secretos, Artifact Registry, las colas de Cloud Tasks y el índice vectorial;
- construye y despliega `xsia-worker` (privado) y `xsia-api` (público);
- publica el frontend en Firebase Hosting con las reglas e índices de Firestore;
- programa el ciclo de Recovery cada minuto.

Al final imprime la URL de la API, la URL del webhook y el **verify token** de WhatsApp.

> Los índices de Firestore tardan algunos minutos en construirse. Mientras su estado no sea *Ready* (Consola → Firestore → Índices), algunas consultas fallarán con `FAILED_PRECONDITION`. Si una pantalla muestra un error de índice faltante, el mensaje trae un enlace para crearlo con un clic.

## 3. Primer ingreso

1. Abre `https://PROJECT_ID.web.app/admin` e inicia sesión con el correo indicado en `ADMIN_EMAILS`.
2. En **Usuarios** asigna roles a los demás. Cada persona aparece en la lista después de su primer inicio de sesión.
3. Opcional: crea datos de demostración con `cd backend && npm install && GOOGLE_CLOUD_PROJECT=$PROJECT_ID npm run seed:demo` y abre `https://PROJECT_ID.web.app/c/demo`.

## 4. Configurar WhatsApp (Meta)

1. En Meta App Dashboard → **WhatsApp → Configuración**, en la sección Webhook:
   - **URL de devolución de llamada:** `https://<URL-de-xsia-api>/webhooks/whatsapp`
   - **Token de verificación:** obtenlo con `gcloud secrets versions access latest --secret=meta-verify-token`
   - Suscribe el campo **messages**.
2. Si no lo diste en el paso 2, guarda el App Secret: `printf 'TU_APP_SECRET' | gcloud secrets versions add meta-app-secret --data-file=-` y vuelve a desplegar con `./infra/deploy.sh backend`.
3. En el administrador, en **Líneas WhatsApp**, agrega cada número con su *Phone number ID*, *WABA ID*, token y límite diario vigente. Haz un **envío de prueba** con una plantilla aprobada.
4. En el agente, en **Canales y voz**, habilita WhatsApp y selecciona las líneas.

## 5. Operar Recovery

Sigue este orden:

1. Crea la campaña.
2. Elige el agente.
3. Configura las plantillas (nombre exacto, idioma y parámetros) y las promociones.
4. Selecciona las líneas y la ventana de envío.
5. Define las reglas, el CRM y la evaluación.
6. Importa los leads.
7. Ejecuta la **prevalidación** y luego **Iniciar**.
8. Vigila los primeros envíos en **Ejecución → Errores por causa** antes de subir el volumen.

## 6. Actualizaciones

```bash
./infra/deploy.sh            # backend + frontend
./infra/deploy.sh backend    # solo Cloud Run
./infra/deploy.sh frontend   # solo Hosting
```

**CI/CD opcional:** en Cloud Build → Activadores, conecta el repositorio de GitHub y crea un activador sobre `main` con `cloudbuild.yaml`. Ese archivo actualiza la imagen de ambos servicios.

## 7. Usar Claude en Vertex AI (facturación por GCP)

1. En Vertex AI → **Model Garden**, habilita los modelos Claude que vayas a usar.
2. Despliega con:

```bash
CLAUDE_PROVIDER=vertex CLAUDE_MODEL_CHAT=<id-del-modelo-en-vertex> CLAUDE_MODEL_FAST=<id-haiku-en-vertex> ./infra/deploy.sh backend
gcloud run services update xsia-api    --region $REGION --update-env-vars CLAUDE_VERTEX_REGION=us-east5
gcloud run services update xsia-worker --region $REGION --update-env-vars CLAUDE_VERTEX_REGION=us-east5
```

Revisa en Model Garden el identificador exacto y la región disponible de cada modelo. La cuenta `xsia-run` ya tiene `roles/aiplatform.user`.

## 8. Variables importantes

| Variable | Descripción |
|---|---|
| `CLAUDE_MODEL_CHAT` / `CLAUDE_MODEL_FAST` | Modelos de conversación y de procesos auxiliares (contextualización, reordenamiento, evaluación). Cada agente puede usar otro modelo de chat |
| `CLAUDE_PRICING_JSON` | Precios por millón de tokens para el costo estimado del Dashboard |
| `EMBEDDINGS_PROVIDER` / `EMBEDDINGS_MODEL` / `EMBEDDING_DIM` | Si cambias la dimensión, recrea el índice vectorial de `chunks` y reindexa |
| `GRAPH_API_VERSION` | Versión de la Graph API de Meta |
| `DEFAULT_COUNTRY_CODE` | Normalización de teléfonos (52 = México) |
| `RECOVERY_MAX_IMPORT_ROWS` / `RECOVERY_MAX_IMPORT_BYTES` | Límites de importación (25,000 filas / 20 MB) |
| `API_MIN_INSTANCES` | Instancias mínimas de la API (1 evita arranques en frío en el webhook y el chat) |

## 9. Diagnóstico

```bash
gcloud run services logs read xsia-api --region $REGION --limit 100
gcloud run services logs read xsia-worker --region $REGION --limit 100
gcloud tasks queues describe xsia-recovery-send --location $REGION
gcloud scheduler jobs run xsia-recovery-tick --location $REGION   # forzar un ciclo
```

| Síntoma | Revisión |
|---|---|
| El chat se queda en "escribiendo" | Revisa que `ANTHROPIC_API_KEY` sea válida y busca errores en los logs de `xsia-api` |
| Un documento queda en *error* | Revisa el mensaje en la tabla. Para PDFs escaneados, comprueba que Claude tenga acceso |
| La búsqueda no devuelve nada | Confirma que el índice vectorial esté en *Ready* y baja la similitud mínima en Documentos |
| La plantilla falla con el error 132001 | El nombre o el idioma no coinciden, o la plantilla no está aprobada |
| No llegan respuestas de WhatsApp | Revisa la suscripción del webhook, `META_APP_SECRET` y la línea registrada con su `phoneNumberId` |
| La campaña no envía | Usa la prevalidación y el campo "⏱" en la lista: ventana horaria, líneas habilitadas, capacidad diaria |

## 10. Costos aproximados (orientativos)

- **Cloud Run:** la API con 1 instancia mínima cuesta ~USD 15–25 al mes; el worker escala a cero.
- **Firestore, Storage, Tasks y Scheduler:** bajo para volúmenes medianos.
- **Claude:** depende de las conversaciones. El Dashboard muestra el costo estimado por agente.
- **Vertex Embeddings:** centavos por cada miles de fragmentos.
