/** Modelos de datos de XSIA Claude (persistidos en Firestore). */

export type Role = 'admin' | 'operator' | 'viewer';
export type Channel = 'web' | 'whatsapp' | 'voice';
export type Origin = 'standard' | 'recovery';

export interface ApiParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
  in: 'query' | 'body' | 'path' | 'header';
  default?: string;
}

/** Herramienta de consulta a servicio externo (máx. 5 por agente) */
export interface ExternalApi {
  id: string;
  name: string;
  description: string; // cuándo y para qué usarla (para Claude)
  url: string; // admite {param} para path params
  method: 'GET' | 'POST' | 'PUT';
  headers: Record<string, string>;
  params: ApiParam[];
  enabled: boolean;
  timeoutMs?: number;
}

export interface FlowVariable {
  name: string;
  description: string;
  required: boolean;
  default?: string;
}

/** Flujo de acción de negocio (máx. 4 por agente) */
export interface ActionFlow {
  id: string;
  name: string;
  description: string; // cuándo usarlo
  variables: FlowVariable[];
  steps?: string; // pasos/condiciones en lenguaje natural para el agente
  url: string;
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  /** JSON con placeholders {{variable}}, {{contact.name}}, {{session.id}}, {{attribution.source}}, {{site.key}}, {{summary}} */
  payloadTemplate: string;
  /** Ruta (a.b.c) en la respuesta donde viene el ID externo (p. ej. ShiftDigital ID) */
  responseIdPath?: string;
  confirmationMessage: string;
  attribution: { source?: string; medium?: string; campaign?: string };
  isLeadCapture: boolean;
  enabled: boolean;
}

export interface WebReference {
  url: string;
  title: string;
  description: string;
}

export interface Agent {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: 'active' | 'inactive';
  model: { chat?: string; fast?: string; temperature: number; maxTokens: number };
  instructions: {
    main: string;
    specific: string;
    welcomeMessage: string;
    stageStart: string;
    stageConversation: string;
    stageClosing: string;
    toolsCriteria: string;
    ctaCriteria: string;
    responseStyle: string;
  };
  leadQualification: {
    enabled: boolean;
    requiredFields: Array<'name' | 'phone' | 'email' | 'interest'>;
    contactRule: 'phone' | 'email' | 'phone_or_email' | 'phone_and_email';
    signals: string;
    rules: string;
  };
  rag: { topK: number; contextualRetrieval: boolean; rerank: boolean; minScore: number };
  webReferences: WebReference[];
  externalApis: ExternalApi[];
  actionFlows: ActionFlow[];
  distribution: {
    published: boolean;
    redirectUrl: string;
    widget: { position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'; size: 'sm' | 'md' | 'lg'; icon: string; color: string; label: string };
    theme: { primaryColor: string; logoUrl: string; title: string };
    starterCtas: string[];
  };
  whatsapp: { enabled: boolean; lineIds: string[] };
  chatManager: { enabled: boolean; webhookUrl: string; headers: Record<string, string>; instructions: string };
  voice: {
    enabled: boolean;
    mode: 'stable' | 'realtime';
    voiceName: string;
    languageCode: string;
    silenceMs: number;
    sensitivity: number; // 0..1
    speakingRate: number;
  };
  dealers: {
    mode: 'none' | 'internal' | 'external';
    externalUrl: string;
    externalMethod: 'GET' | 'POST';
    headers: Record<string, string>;
    brandFilter: string;
    defaultCount: number;
  };
  createdAt?: any;
  updatedAt?: any;
}

export interface Site {
  id: string;
  key: string;
  name: string;
  dealerCode?: string;
  instructions: string;
  params?: Record<string, string>;
  enabled: boolean;
}

export interface Contact {
  name?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  interest?: string;
  postalCode?: string;
}

export interface Session {
  id: string;
  agentId: string;
  origin: Origin;
  channel: Channel;
  campaignId?: string | null;
  leadId?: string | null;
  siteKey?: string | null;
  lineId?: string | null;
  userPhone?: string | null;
  contact: Contact;
  startedAt: any;
  lastActivityAt: any;
  messageCount: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  leadCaptured?: boolean;
  handoff?: boolean;
  flowRuns?: Record<string, { status: string; externalId?: string; at: string }>;
  lockUntil?: number;
}

export type LeadType = 'NOT_CONTACTED' | 'ABANDONED' | 'REJECTED';
export const LEAD_TYPES: LeadType[] = ['NOT_CONTACTED', 'ABANDONED', 'REJECTED'];

export type LeadStatus =
  | 'PENDING'
  | 'SCHEDULED'
  | 'SENDING'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'REPLIED'
  | 'FAILED'
  | 'CANCELLED'
  | 'NO_RESPONSE';

export type LeadOutcome = 'INTERESTED' | 'RECOVERED' | 'NOT_RECOVERED' | 'NOT_INTERESTED' | 'COMPLAINT' | 'OPTOUT' | null;

export interface TemplateConfig {
  name: string;
  language: string;
  /** Campos de lead en orden para los parámetros {{1}},{{2}}...: firstName, brand, model, promotion, version, year, dealerName, fullName */
  params: string[];
  /** Si la plantilla tiene header de imagen */
  headerImageUrl?: string;
  /** Texto aproximado de la plantilla aprobada con {{1}}, {{2}}… (para contexto del agente y reportes) */
  previewText: string;
  context: string;
  crmOrigin: string;
  originDescription: string;
  enabled: boolean;
}

export interface Campaign {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'running' | 'paused' | 'cancelled' | 'completed';
  agentId: string;
  actionFlowId?: string;
  agentInstructions: string;
  templates: Record<LeadType, TemplateConfig>;
  secondAttemptTemplates?: Partial<Record<LeadType, TemplateConfig>>;
  promotions: { rules: Array<{ brand?: string; model?: string; version?: string; year?: string; text: string }>; defaultText: string };
  whatsapp: {
    lineIds: string[];
    strategy: 'balanced' | 'weighted' | 'specific';
    weights: Record<string, number>;
    specificLineId?: string;
    window: { startHour: number; endHour: number; days: number[]; timezone: string };
    maxPerHour: number;
    maxConcurrent: number;
  };
  rules: { noResponseHours: number; markNoResponse: boolean; secondAttempt: boolean; secondAttemptDelayHours: number };
  crm: {
    mode: 'webhook' | 'action_flow' | 'none';
    url: string;
    method: 'POST' | 'PUT';
    headers: Record<string, string>;
    payloadTemplate: string;
    responseIdPath: string;
    excludeOriginalDealer: boolean;
    dealerCount: number;
    customerServiceMessage: string;
    customerServicePhone: string;
    customerServiceEmail: string;
  };
  evaluation: { mood: boolean; purchaseIntent: boolean; recoveryProbability: boolean; complaint: boolean; optOut: boolean };
  currentExecutionId?: string | null;
  createdAt?: any;
  updatedAt?: any;
  createdBy?: string;
}

export interface Lead {
  id: string; // teléfono normalizado (unicidad por campaña)
  campaignId: string;
  sourceId?: string;
  firstName?: string;
  lastName?: string;
  phone: string;
  email?: string;
  zip?: string;
  type: LeadType;
  reason?: string;
  brand?: string;
  model?: string;
  version?: string;
  year?: string;
  originalDealerId?: string;
  originalDealerName?: string;
  originalDate?: string;
  summary?: string;
  consentWhatsApp?: boolean | null;
  doNotContact?: boolean;
  eligible: boolean;
  ineligibleReason?: string | null;
  batchId: string;
  importedAt: any;
  status: LeadStatus;
  outcome: LeadOutcome;
  attempts: number;
  lastAttemptId?: string | null;
  lastSentAt?: any;
  nextAttemptAt?: any;
  repliedAt?: any;
  lineId?: string | null;
  sessionId?: string | null;
  evaluation?: {
    mood?: 'positive' | 'neutral' | 'negative' | 'undetermined';
    anger?: boolean;
    purchaseIntent?: 'high' | 'medium' | 'low' | 'none';
    recoveryProbability?: number;
    complaint?: boolean;
    optOut?: boolean;
    updatedAt?: any;
  };
  selectedDealer?: { id: string; name: string } | null;
  crm?: { status: 'pending' | 'accepted' | 'rejected' | 'error'; externalId?: string; error?: string; attemptedAt?: any; httpStatus?: number } | null;
  searchTokens: string[];
}

export interface WaLine {
  id: string;
  name: string;
  phoneNumberId: string;
  wabaId: string;
  displayPhone: string;
  accessToken: string;
  enabled: boolean;
  dailyLimit: number;
  defaultAgentId?: string;
}

export interface Dealer {
  id: string;
  name: string;
  brand?: string;
  type?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  lat?: number;
  lng?: number;
  phone?: string;
  url?: string;
}
