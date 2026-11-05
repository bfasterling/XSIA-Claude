/**
 * Configuración central. Todo se lee de variables de entorno (Cloud Run) y
 * los secretos se montan desde Secret Manager como variables.
 */
const PLACEHOLDERS = ['PENDIENTE', 'NONE', 'pending'];
/** Lee una variable; los valores de relleno de Secret Manager (PENDIENTE/NONE) cuentan como vacíos */
const env = (k: string, d = ''): string => {
  const v = process.env[k];
  return v === undefined || PLACEHOLDERS.includes(v.trim()) ? d : v;
};
const num = (k: string, d: number): number => (process.env[k] ? Number(process.env[k]) : d);
const bool = (k: string, d = false): boolean =>
  process.env[k] ? ['1', 'true', 'yes'].includes(String(process.env[k]).toLowerCase()) : d;

export const config = {
  /** api = servicio público; worker = tareas internas; all = ambos (desarrollo local) */
  role: env('ROLE', 'all') as 'api' | 'worker' | 'all',
  port: num('PORT', 8080),
  projectId: env('GOOGLE_CLOUD_PROJECT', env('GCLOUD_PROJECT', '')),
  region: env('GCP_REGION', 'us-central1'),
  publicBaseUrl: env('PUBLIC_BASE_URL', 'http://localhost:5173'),
  apiBaseUrl: env('API_BASE_URL', 'http://localhost:8080'),
  corsOrigins: env('CORS_ORIGINS', '*'),
  adminEmails: env('ADMIN_EMAILS', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  defaultTimezone: env('DEFAULT_TIMEZONE', 'America/Mexico_City'),

  storage: {
    bucket: env('GCS_BUCKET', ''),
    /** Bucket público (o con CDN) para imágenes de la librería de medios */
    mediaBucket: env('GCS_MEDIA_BUCKET', env('GCS_BUCKET', '')),
    mediaPublic: bool('GCS_MEDIA_PUBLIC', true),
  },

  claude: {
    /** anthropic = API directa de Anthropic; vertex = Claude en Vertex AI (Model Garden) */
    provider: env('CLAUDE_PROVIDER', 'anthropic') as 'anthropic' | 'vertex',
    apiKey: env('ANTHROPIC_API_KEY', ''),
    vertexRegion: env('CLAUDE_VERTEX_REGION', 'us-east5'),
    chatModel: env('CLAUDE_MODEL_CHAT', 'claude-sonnet-5-5'),
    fastModel: env('CLAUDE_MODEL_FAST', 'claude-haiku-5-5'),
    maxToolIterations: num('CLAUDE_MAX_TOOL_ITERATIONS', 6),
    /** Precios USD por millón de tokens (ajustables sin redeploy de código) */
    pricing: JSON.parse(
      env(
        'CLAUDE_PRICING_JSON',
        JSON.stringify({
          default: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
          sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          opus: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        }),
      ),
    ) as Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>,
  },

  embeddings: {
    /** vertex = Vertex AI (nativo GCP) | voyage = Voyage AI (recomendado por Anthropic) */
    provider: env('EMBEDDINGS_PROVIDER', 'vertex') as 'vertex' | 'voyage',
    vertexModel: env('EMBEDDINGS_MODEL', 'text-multilingual-embedding-002'),
    vertexRegion: env('EMBEDDINGS_REGION', env('GCP_REGION', 'us-central1')),
    voyageApiKey: env('VOYAGE_API_KEY', ''),
    voyageModel: env('VOYAGE_MODEL', 'voyage-3.5'),
    /** Debe coincidir con la dimensión del índice vectorial de Firestore */
    dimension: num('EMBEDDING_DIM', 768),
  },

  rag: {
    chunkSize: num('RAG_CHUNK_CHARS', 2200),
    chunkOverlap: num('RAG_CHUNK_OVERLAP', 250),
    maxDocumentBytes: num('RAG_MAX_DOC_BYTES', 30 * 1024 * 1024),
  },

  tasks: {
    /** Si está vacío, las tareas se ejecutan en el mismo proceso (modo local) */
    queueLocation: env('TASKS_LOCATION', env('GCP_REGION', 'us-central1')),
    queueDefault: env('TASKS_QUEUE', 'xsia-default'),
    queueSend: env('TASKS_QUEUE_SEND', 'xsia-recovery-send'),
    workerUrl: env('WORKER_URL', ''),
    invokerServiceAccount: env('TASKS_INVOKER_SA', ''),
    sharedSecret: env('TASKS_SHARED_SECRET', ''),
  },

  whatsapp: {
    graphVersion: env('GRAPH_API_VERSION', 'v23.0'),
    appSecret: env('META_APP_SECRET', ''),
    verifyToken: env('META_VERIFY_TOKEN', ''),
    sessionTtlHours: num('WA_SESSION_TTL_HOURS', 24),
  },

  google: {
    mapsApiKey: env('GOOGLE_MAPS_API_KEY', ''),
    ttsEnabled: bool('GOOGLE_TTS_ENABLED', true),
    sttEnabled: bool('GOOGLE_STT_ENABLED', true),
  },

  recovery: {
    maxImportRows: num('RECOVERY_MAX_IMPORT_ROWS', 25000),
    maxImportBytes: num('RECOVERY_MAX_IMPORT_BYTES', 20 * 1024 * 1024),
    defaultCountryCode: env('DEFAULT_COUNTRY_CODE', '52'),
  },
};

export type AppConfig = typeof config;
