# Despliegue 100 % en la nube (Google Cloud Console + GitHub + Cloud Build)

No requiere nada instalado en tu computadora; todo se hace desde el navegador. GitHub es la fuente del código y **cada `push` a `main` despliega automáticamente** con Cloud Build.

```
GitHub (bfasterling/xsia-claude)
   │ push a main
   ▼
Cloud Build ── activador "xsia-backend"  → Artifact Registry → Cloud Run (xsia-worker privado + xsia-api público)
            └─ activador "xsia-frontend" → Firebase Hosting (admin, chat, widget) + reglas/índices de Firestore
Cloud Run ── Firestore · Cloud Storage · Cloud Tasks · Secret Manager · Vertex AI · Claude (Anthropic)
Cloud Scheduler (cada minuto) → xsia-worker /tasks/recovery-tick
```

En toda la guía, `PROYECTO` es el **ID de tu proyecto** y la región es **us-central1**.

---

## Paso 1. Crear el proyecto y la facturación
1. Entra a https://console.cloud.google.com → selector de proyectos (arriba) → **Proyecto nuevo** → nombre `xsia-claude` → **Crear**. Anota el **ID del proyecto**.
2. Menú ☰ → **Facturación** → vincula una cuenta de facturación al proyecto.

## Paso 2. Habilitar las APIs
Abre este enlace con el proyecto seleccionado y pulsa **Habilitar**:

https://console.cloud.google.com/flows/enableapi?apiid=run.googleapis.com,cloudbuild.googleapis.com,artifactregistry.googleapis.com,firestore.googleapis.com,cloudtasks.googleapis.com,cloudscheduler.googleapis.com,secretmanager.googleapis.com,aiplatform.googleapis.com,storage.googleapis.com,texttospeech.googleapis.com,speech.googleapis.com,iam.googleapis.com,firebase.googleapis.com,firebasehosting.googleapis.com,firebaserules.googleapis.com,identitytoolkit.googleapis.com,geocoding-backend.googleapis.com,serviceusage.googleapis.com

## Paso 3. Firebase (autenticación, hosting y Firestore)
1. Abre https://console.firebase.google.com → **Agregar proyecto** → elige **tu proyecto de GCP existente** → continúa. Como el proyecto ya tiene facturación, queda en plan Blaze.
2. **Compilación → Authentication → Comenzar** → en **Método de acceso** habilita **Correo electrónico/contraseña** y **Google**.
3. **Configuración del proyecto (⚙) → General → Tus apps → Web (`</>`)** → apodo `xsia-admin` → **Registrar**. Copia `apiKey`, `authDomain` y `appId`; los usarás en el Paso 10.
4. **Compilación → Firestore Database → Crear base de datos** → **Modo de producción** → ubicación **nam5 (us-central)** → Crear. Las reglas se publican solas desde el repositorio.
5. Si **Hosting** te pide "Comenzar", sigue el asistente hasta el final sin ejecutar comandos.

## Paso 4. Buckets de Cloud Storage
Ve a ☰ → **Cloud Storage → Buckets → Crear**:

| Bucket | Región | Acceso |
|---|---|---|
| `PROYECTO-xsia-data` | us-central1 (Region) | Uniforme · prevención de acceso público **activada** |
| `PROYECTO-xsia-media` | us-central1 (Region) | Uniforme · **desmarca** "Aplicar la prevención del acceso público" |

En `PROYECTO-xsia-media`, ve a **Permisos → Otorgar acceso**, con principal `allUsers` y rol **Visualizador de objetos de Storage**. Es necesario para que las imágenes se vean en el chat y se envíen por WhatsApp.

## Paso 5. Cuentas de servicio y permisos
Ve a ☰ → **IAM y administración → Cuentas de servicio → Crear cuenta de servicio** y crea estas tres:

| Cuenta | Para qué |
|---|---|
| `xsia-run` | La aplicación en Cloud Run |
| `xsia-tasks` | Invocar el worker desde Cloud Tasks y Cloud Scheduler |
| `xsia-deployer` | Cloud Build (desplegar) |

Luego ve a ☰ → **IAM y administración → IAM → Otorgar acceso** y asigna los roles de proyecto:

**xsia-run@PROYECTO.iam.gserviceaccount.com**
- Usuario de Cloud Datastore
- Encolador de Cloud Tasks
- Usuario de Vertex AI
- Descriptor de acceso a secretos de Secret Manager
- Administrador de objetos de Storage
- Escritor de registros
- Visualizador de Firebase Authentication
- Consumidor de Service Usage

**xsia-deployer@PROYECTO.iam.gserviceaccount.com**
- Administrador de Cloud Run
- Usuario de cuenta de servicio
- Escritor de Artifact Registry
- Escritor de registros
- Administrador de Firebase
- Administrador de índices de Cloud Datastore
- Consumidor de Service Usage

Por último, en **Cuentas de servicio**, abre `xsia-tasks` → pestaña **Principales con acceso → Otorgar acceso** → principal `xsia-run@PROYECTO.iam.gserviceaccount.com` → rol **Usuario de cuenta de servicio**. Esto permite que la app cree tareas firmadas.

## Paso 6. Secretos (Claude y Meta)
1. Obtén tu llave de Claude en https://console.anthropic.com → **API Keys → Create Key**.
2. Ve a ☰ → **Seguridad → Secret Manager → Crear secreto**. Crea cada uno con exactamente este nombre:

| Nombre | Valor |
|---|---|
| `anthropic-api-key` | Tu llave `sk-ant-…` |
| `meta-app-secret` | El App Secret de Meta, o `NONE` si aún no lo tienes |
| `meta-verify-token` | Una palabra secreta que tú inventes, p. ej. `xsia-verifica-2026` |
| `google-maps-api-key` | Llave de Geocoding API (opcional), o `NONE` |

La llave de Maps se crea en ☰ → APIs y servicios → Credenciales → Crear credenciales → Clave de API, restringida a "Geocoding API".

> Para cambiar un secreto después: ábrelo → **Nueva versión**. Luego vuelve a ejecutar el activador del backend (Paso 9) para que Cloud Run tome el valor nuevo.

## Paso 7. Artifact Registry
Ve a ☰ → **Artifact Registry → Repositorios → Crear repositorio**:
- Nombre `xsia`
- Formato **Docker**
- Modo estándar
- Región **us-central1**

## Paso 8. Colas de Cloud Tasks
Ve a ☰ → **Cloud Tasks → Crear cola**, en región us-central1:

| Cola | Configuración |
|---|---|
| `xsia-default` | Envíos simultáneos máx. **20**, reintentos máx. **8** |
| `xsia-recovery-send` | Envíos por segundo **5**, simultáneos máx. **10**, reintentos máx. **3** |

Si la consola no muestra el botón, abre **Cloud Shell** (icono `>_` arriba a la derecha; es una terminal en la nube) y ejecuta:
```bash
gcloud tasks queues create xsia-default --location=us-central1 --max-concurrent-dispatches=20 --max-attempts=8
gcloud tasks queues create xsia-recovery-send --location=us-central1 --max-dispatches-per-second=5 --max-concurrent-dispatches=10 --max-attempts=3
```

## Paso 9. Conectar GitHub y crear el activador del BACKEND
1. Ve a ☰ → **Cloud Build → Repositorios → pestaña 2ª generación → Crear conexión de host**:
   - Proveedor **GitHub**, región us-central1, nombre `github`.
   - **Conectar** → autoriza la app "Google Cloud Build" en tu cuenta `bfasterling`, con acceso al repositorio `xsia-claude`.
2. **Vincular repositorio** → elige `bfasterling/xsia-claude`.
3. Ve a **Cloud Build → Activadores → Crear activador**:
   - Nombre: `xsia-backend` · Región: **us-central1**
   - Evento: **Enviar a una rama** · Repositorio: `bfasterling/xsia-claude` · Rama: `^main$`
   - Filtros de archivos incluidos: `backend/**` y `cloudbuild.yaml`
   - Configuración: **Archivo de configuración de Cloud Build** → `cloudbuild.yaml`
   - Variables de sustitución: `_ADMIN_EMAILS` = tu correo. Si son varios, sepáralos con `;`.
   - Cuenta de servicio: `xsia-deployer@PROYECTO.iam.gserviceaccount.com`
   - **Crear**
4. En la lista de activadores, pulsa **Ejecutar** en `xsia-backend` (rama main). Sigue el avance en **Historial**; tarda unos 5–8 minutos. Al terminar, el registro muestra la URL de la API, la del worker y la del webhook.

## Paso 10. Activador del FRONTEND
1. Ve a **Cloud Build → Activadores → Crear activador**:
   - Nombre `xsia-frontend` · región us-central1 · mismo repositorio y rama `^main$`
   - Archivos incluidos: `frontend/**`, `firebase.json`, `firestore.rules`, `firestore.indexes.json` y `cloudbuild-frontend.yaml`
   - Configuración: `cloudbuild-frontend.yaml`
   - Variables (del Paso 3.3):
     - `_FIREBASE_API_KEY` = apiKey
     - `_FIREBASE_AUTH_DOMAIN` = `PROYECTO.firebaseapp.com`
     - `_FIREBASE_APP_ID` = appId
   - Cuenta de servicio: `xsia-deployer`
2. Pulsa **Ejecutar**. Este activador publica el sitio y también las reglas e índices de Firestore, incluido el **índice vectorial del RAG**.
3. Revisa los índices en Firebase → Firestore → **Índices**. Tardan unos minutos en quedar en "Habilitado".

> Si el índice vectorial no aparece, créalo desde Cloud Shell:
> `gcloud firestore indexes composite create --collection-group=chunks --query-scope=COLLECTION --field-config=field-path=agentId,order=ascending --field-config='field-path=embedding,vector-config={"dimension":"768","flat":"{}"}'`

## Paso 11. Programador de Recovery (Cloud Scheduler)
1. Ve a ☰ → **Cloud Run → xsia-worker** y copia su **URL**.
2. Ve a ☰ → **Cloud Scheduler → Crear trabajo**:
   - Nombre `xsia-recovery-tick` · región us-central1 · frecuencia `* * * * *` · zona horaria America/Mexico_City
   - Destino **HTTP**:
     - URL: `URL-DEL-WORKER/tasks/recovery-tick`
     - Método **POST**
     - Encabezado `Content-Type: application/json`
     - Cuerpo `{}`
   - Encabezado de autenticación: **Agregar token OIDC** → cuenta `xsia-tasks@PROYECTO.iam.gserviceaccount.com` → público (audience) = URL del worker
   - **Crear**

## Paso 12. Entrar a la aplicación
- Administrador: `https://PROYECTO.web.app/admin`. Inicia sesión con Google o crea tu usuario en Firebase → Authentication → Agregar usuario. El correo de `_ADMIN_EMAILS` entra como administrador.
- Para invitar a más personas: entran una vez y luego les asignas rol en **Usuarios**.
- Crea un agente en **Agentes → Nuevo agente**, sube documentos y pruébalo con **Probar chat**: `https://PROYECTO.web.app/c/<identificador>`.

## Paso 13. Claude (opciones)
- **API de Anthropic (predeterminado):** basta con el secreto `anthropic-api-key`. El activador del backend define los modelos en `_CLAUDE_MODEL_CHAT` y `_CLAUDE_MODEL_FAST`.
- **Claude en Vertex AI (facturación por GCP):**
  1. Ve a ☰ → **Vertex AI → Model Garden**, busca "Claude" y **habilita** los modelos.
  2. En el activador `xsia-backend` → **Editar → Variables**, define:
     - `_CLAUDE_PROVIDER=vertex`
     - `_CLAUDE_MODEL_CHAT` y `_CLAUDE_MODEL_FAST` con los ID exactos que muestra Model Garden
     - `_CLAUDE_VERTEX_REGION` con la región del modelo, p. ej. `us-east5`
  3. **Ejecuta** el activador.

## Paso 14. WhatsApp (Meta)
1. En https://developers.facebook.com → tu app → **WhatsApp → Configuración → Webhook**:
   - URL de devolución de llamada: `URL-DE-xsia-api/webhooks/whatsapp`
   - Token de verificación: el valor del secreto `meta-verify-token`
   - Suscríbete al campo **messages**
2. En **Configuración básica**, copia el **App Secret** y guárdalo como nueva versión de `meta-app-secret`. Después vuelve a ejecutar el activador `xsia-backend`.
3. Crea un **System User** con token permanente (Business Manager → Usuarios del sistema), con permisos `whatsapp_business_messaging` y `whatsapp_business_management`.
4. En el administrador XSIA, ve a **Líneas WhatsApp → Agregar línea**: Phone number ID, WABA ID, token y límite diario. Haz un **envío de prueba** con una plantilla aprobada.
5. En el agente, ve a **Canales y voz → WhatsApp**: habilítalo y elige la línea.

## Paso 15. Actualizaciones
Cada cambio que se suba a `main` en GitHub despliega solo lo que cambió: el backend si cambió `backend/**`, el frontend si cambió `frontend/**`. Para forzar un despliegue, ve a **Cloud Build → Activadores → Ejecutar**.

## Diagnóstico (todo desde la consola)
| Dónde | Qué revisar |
|---|---|
| Cloud Build → Historial | Errores de compilación o despliegue |
| Cloud Run → xsia-api / xsia-worker → **Registros** | Errores del chat, webhook, ingesta y envíos |
| Cloud Tasks → colas | Tareas pendientes o con reintentos |
| Cloud Scheduler → xsia-recovery-tick → **Ejecutar ahora** | Forzar un ciclo de Recovery |
| Firestore → Índices | Que todos estén "Habilitado" (si falta uno, el error en los registros trae un enlace para crearlo) |

| Síntoma | Revisión |
|---|---|
| El chat no responde | Secreto `anthropic-api-key` y registros de `xsia-api` |
| El admin dice "no tiene rol" | `_ADMIN_EMAILS` en el activador del backend; vuelve a ejecutarlo |
| Un documento queda en "error" | El mensaje aparece en la tabla de Documentos |
| La búsqueda no devuelve nada | Índice vectorial de `chunks` habilitado |
| Error 132001 al enviar la plantilla | Nombre o idioma incorrectos, o la plantilla no está aprobada |
| No llegan respuestas de WhatsApp | Webhook suscrito, `meta-app-secret` correcto, línea registrada |
