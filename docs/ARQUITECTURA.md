# Arquitectura de XSIA Claude

## 1. Componentes

| Componente | Servicio GCP | Función |
|---|---|---|
| `xsia-api` | Cloud Run (público) | API pública del chat (SSE), API de administración, webhook de WhatsApp y voz |
| `xsia-worker` | Cloud Run (privado, OIDC) | Ingesta RAG, crawler, importación de leads, programador y envíos de Recovery, procesamiento de mensajes entrantes y evaluación |
| Frontend | Firebase Hosting | Administrador `/admin`, chat `/c/:slug` y `widget.js` |
| Autenticación | Firebase Auth | Correo/contraseña o Google; roles en `users/{uid}` (admin, operator, viewer) |
| Base de datos | Firestore (nativo) | Toda la configuración, las conversaciones, Recovery y los vectores del RAG |
| Archivos | Cloud Storage | Originales de documentos, filas de los CSV, archivos de importación y medios (bucket público) |
| Colas | Cloud Tasks | `xsia-default` (ingesta, entrantes, evaluación) y `xsia-recovery-send` (ritmo de envíos) |
| Programador | Cloud Scheduler | `recovery-tick` cada minuto: sin respuesta, segundos intentos y reserva de envíos |
| Secretos | Secret Manager | Llave de Anthropic, secretos de Meta, secreto de tareas y llave de Google Maps |
| IA | Claude (API de Anthropic o Vertex AI) | Conversación y todos los procesos de razonamiento |
| Embeddings | Vertex AI `text-multilingual-embedding-002` (o Voyage AI) | Vectores para la búsqueda semántica |

Ambos servicios usan **la misma imagen**; la variable `ROLE` define qué rutas expone. En local, `ROLE=all` ejecuta todo en un proceso y las tareas corren en memoria.

## 2. Propuesta de almacenamiento del RAG

Claude no ofrece un modelo de embeddings propio; Anthropic recomienda Voyage AI. Para mantener todo dentro de GCP y de Firestore se propone lo siguiente:

1. **Original:** el archivo se guarda en `gs://<proyecto>-xsia-data/agents/{agentId}/documents/{docId}/…`, para reindexar o auditar.
2. **Extracción:**
   - PDF con `pdf-parse`. Si el PDF es escaneado o tiene poco texto, **Claude lo lee de forma nativa** (bloque `document`).
   - DOCX con `mammoth` y XLSX con `exceljs`.
   - HTML con `cheerio`.
   - Imágenes: **Claude visión** extrae su texto y su descripción.
3. **Fragmentación:** fragmentos de unos 2,200 caracteres por párrafos, con 250 de traslape.
4. **Contextual Retrieval (Claude Haiku):** se antepone a cada fragmento una o dos oraciones que lo sitúan dentro del documento. El documento completo se envía con `cache_control`, así que su costo se cobra una sola vez. Esta técnica de Anthropic reduce de forma notable los fallos de recuperación.
5. **Embeddings:** Vertex AI con 768 dimensiones (`RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY`).
6. **Almacenamiento vectorial:** colección `chunks` de Firestore, con el campo `embedding` (tipo `vector`) y un índice vectorial compuesto `agentId + embedding`. La consulta es `findNearest` con distancia COSINE, filtrada por agente. No hace falta otra base de datos.
7. **Recuperación:** la herramienta `buscar_conocimiento`, que Claude invoca cuando la pregunta lo requiere, devuelve los top K fragmentos por encima de la similitud mínima. **Opcional:** reordenamiento con Claude Haiku.
8. **Generación:** Claude responde citando solo información recuperada y no inventa datos.

Las demás fuentes no usan vectores:

- **CSV:** se guarda como JSON en Cloud Storage con su esquema en Firestore. Claude construye filtros estructurados con la herramienta `consultar_base_datos`, que se ejecutan en memoria. Así los números (precios, existencias) son exactos, cosa que la búsqueda semántica no garantiza.
- **Medios:** se usan las descripciones, que Claude genera con visión, las etiquetas y la vigencia. Claude elige el recurso según el contexto de la conversación (`mostrar_recursos`).
- **Referencias web manuales:** van dentro del prompt. Claude puede ofrecerlas sin afirmar que leyó su contenido.

Para escalar a millones de fragmentos o necesitar búsqueda híbrida (BM25 + vectores), la alternativa es Vertex AI Vector Search o AlloyDB con pgvector. La interfaz `rag/search.ts` aísla ese cambio.

## 3. Motor conversacional

`chat/engine.ts` implementa un ciclo agéntico:

```
prompt de sistema (estático, en caché) + contexto dinámico + historial + mensaje
  → Claude (streaming) → ¿tool_use? → ejecuta herramientas en paralelo → tool_result → Claude …  (máx. 6 iteraciones)
  → texto final + <ctas>[…]</ctas> → la UI muestra botones; en WhatsApp se envían botones o una lista
```

Herramientas según la configuración del agente:

- `buscar_conocimiento`, `consultar_base_datos`, `buscar_imagenes`, `mostrar_recursos`
- `api_*` (hasta 5): **consulta**
- `flujo_*` (hasta 4): **acción**. Idempotente por sesión, registra etapas en `actionLogs` y solo se confirma como aceptada con un ID externo cuando se configura `responseIdPath`
- `registrar_datos_contacto`, `buscar_distribuidores`, `transferir_a_asesor`
- Solo en Recovery: `confirmar_interes`, `seleccionar_distribuidor_y_transferir` (transacción que impide transferencias duplicadas), `registrar_no_contactar`, `registrar_queja`, `cerrar_sin_interes`

Se usa *prompt caching* en las instrucciones y en las herramientas. El costo estimado se calcula con `CLAUDE_PRICING_JSON`.

## 4. Recovery: flujo técnico

1. **Importación:** se sube el archivo, se muestran sus columnas y un mapeo sugerido, y la tarea `recovery-import` hace lo siguiente:
   - normaliza teléfonos (MX: 52 + 10 dígitos);
   - deduplica por teléfono y conserva el lead más reciente;
   - aplica supresiones, opt-out y consentimiento;
   - usa como ID del documento el teléfono, lo que garantiza unicidad por campaña.
2. **Tick por minuto:**
   - pasa a `NO_RESPONSE` los leads que corresponda o programa el segundo intento;
   - dentro de la ventana y del calendario, calcula el presupuesto. Es el mínimo entre el límite por hora menos lo enviado en la última hora, la concurrencia menos los envíos en vuelo, la capacidad diaria de las líneas habilitadas y un suavizado por minuto;
   - reserva leads en una transacción (`PENDING → SCHEDULED`) y elige la línea (balanceada, ponderada o específica);
   - encola `recovery-send` repartido a lo largo del minuto.
3. **Envío:**
   - verifica el estado de la campaña. Si está en pausa o cancelada, libera la reserva y el lead vuelve a `PENDING`;
   - revisa elegibilidad y supresión, y marca `SENDING` de forma atómica;
   - envía la plantilla con sus parámetros y la promoción;
   - registra el intento con su error detallado y crea `waMessages/{wamid}` y la ruta `waContacts/{línea_teléfono}`.
4. **Estados:** el webhook actualiza `SENT → DELIVERED → READ`, siempre hacia adelante, o `FAILED`.
5. **Respuesta del cliente:**
   - la ruta lleva a la campaña, el lead y el agente, y crea una sesión `origin=recovery`;
   - Claude responde con el contexto del lead y del mensaje inicial;
   - si hay transferencia aceptada, el mensaje de atención a clientes se envía por separado;
   - después se encola la evaluación.

Los envíos ya aceptados por el canal no se pueden retirar. Cancelar solo libera lo que no se ha enviado.

## 5. Modelo de datos (Firestore)

```
users/{uid}                               email, role, disabled
agents/{agentId}                          configuración completa del agente
  sites/{siteId}                          multisitio: key, name, dealerCode, instructions, enabled
  documents/{docId}                       name, title, instructions, gcsPath, status, chunks, sourceType(file|web), url
  datasets/{dsId}                         name, purpose, columns[{name,type,description}], rowCount, gcsPath, enabled
  media/{mediaId}                         name, description, tags, url, mimeType, expiresAt, enabled
  webSources/{id}                         url, sitemapUrl, maxPages, status, pagesIndexed, failed[]
  stats/{yyyy-mm-dd}                      sessions, interactions, tokens, costUsd, leads, byOrigin/bySite/byChannel/byCampaign
chunks/{id}                               agentId, documentId, title, url, text, context, embedding(vector)
sessions/{id}                             agentId, origin, channel, siteKey, campaignId, leadId, lineId, contact, usage, costUsd, flowRuns
  messages/{id}                           role, kind, content(bloques de Claude), display{text,ctas,media}, seq
actionLogs/{id}                           kind, stage(prepared|sent|accepted|rejected), payload, httpStatus, externalId
waLines/{id}                              phoneNumberId, wabaId, accessToken, enabled, dailyLimit, defaultAgentId
waContacts/{lineId_phone}                 enrutamiento de entrantes: sessionId, agentId, campaignId, leadId, templateText
waMessages/{wamid}                        campaignId, leadId, attemptId (para webhooks de estado)
waInbound/{msgId}                         deduplicación de webhooks
lineUsage/{lineId_yyyy-mm-dd}             count (límite diario por línea)
campaigns/{id}                            configuración de las 11 secciones, status, counters, currentExecutionId
  leads/{phone}                           datos del lead, elegibilidad, status, outcome, evaluation, selectedDealer, crm
  batches/{id}                            lote de importación: mapping, stats, errors
  executions/{id}                         periodos de ejecución
  attempts/{id}                           intento: línea, plantilla, parámetros, estados, error, waMessageId
suppressions/{phone}                      lista global de no contactar
dealers/{code}                            directorio: name, brand, city, state, zip, lat, lng
```

## 6. Seguridad

- Las reglas de Firestore niegan todo acceso directo; solo la API, con su cuenta de servicio, accede a los datos.
- El administrador requiere un ID token de Firebase y un rol. GET exige `viewer`, cualquier escritura exige `operator` y las eliminaciones críticas exigen `admin`.
- El webhook de WhatsApp valida la firma `X-Hub-Signature-256` con el App Secret.
- El worker no es público. Cloud Tasks y Scheduler lo invocan con OIDC más un secreto compartido.
- Los tokens de las líneas nunca se devuelven al navegador; se muestran enmascarados.
- La API pública tiene límites de tasa por IP.
