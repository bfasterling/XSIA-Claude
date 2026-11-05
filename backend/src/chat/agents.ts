import { col } from '../lib/firestore.js';
import type { Agent, Site } from '../types.js';

export const AGENT_DEFAULTS: Omit<Agent, 'id' | 'name' | 'slug'> = {
  description: '',
  status: 'active',
  model: { temperature: 0.3, maxTokens: 1500 },
  instructions: {
    main: 'Eres un asesor conversacional profesional, amable y preciso. Respondes en español de México salvo que el usuario escriba en otro idioma.',
    specific: '',
    welcomeMessage: '¡Hola! Soy tu asesor virtual. ¿En qué te puedo ayudar hoy?',
    stageStart: 'Saluda brevemente, preséntate y pregunta en qué puedes ayudar.',
    stageConversation: 'Responde con precisión usando el conocimiento disponible, aprovecha el contexto y orienta hacia el siguiente paso comercial.',
    stageClosing: 'Resume lo acordado, agradece y confirma el siguiente paso.',
    toolsCriteria: '',
    ctaCriteria: 'Sugiere hasta 3 siguientes pasos relacionados con la última respuesta (p. ej. ver versiones, cotizar, buscar distribuidor, hablar con asesor).',
    responseStyle: 'Respuestas breves y claras, en primera persona.',
  },
  leadQualification: { enabled: true, requiredFields: ['name', 'phone'], contactRule: 'phone_or_email', signals: '', rules: '' },
  rag: { topK: 6, contextualRetrieval: true, rerank: false, minScore: 0.35 },
  webReferences: [],
  externalApis: [],
  actionFlows: [],
  distribution: {
    published: true,
    redirectUrl: '',
    widget: { position: 'bottom-right', size: 'md', icon: 'chat', color: '#1f6feb', label: '¿Te ayudo?' },
    theme: { primaryColor: '#1f6feb', logoUrl: '', title: '' },
    starterCtas: [],
  },
  whatsapp: { enabled: false, lineIds: [] },
  chatManager: { enabled: false, webhookUrl: '', headers: {}, instructions: '' },
  voice: { enabled: false, mode: 'stable', voiceName: 'es-US-Neural2-A', languageCode: 'es-US', silenceMs: 1200, sensitivity: 0.5, speakingRate: 1 },
  dealers: { mode: 'none', externalUrl: '', externalMethod: 'GET', headers: {}, brandFilter: '', defaultCount: 3 },
};

/** Mezcla profunda simple de valores por defecto */
export function withDefaults<T>(defaults: T, data: any): T {
  if (Array.isArray(defaults)) return (data ?? defaults) as T;
  if (typeof defaults !== 'object' || defaults === null) return (data ?? defaults) as T;
  const out: any = { ...(defaults as any) };
  for (const [k, v] of Object.entries(data || {})) {
    const d = (defaults as any)[k];
    out[k] = d && typeof d === 'object' && !Array.isArray(d) && v && typeof v === 'object' && !Array.isArray(v) ? withDefaults(d, v) : v;
  }
  return out;
}

const cache = new Map<string, { at: number; agent: Agent }>();

export async function getAgent(id: string, fresh = false): Promise<Agent | null> {
  const hit = cache.get(id);
  if (!fresh && hit && Date.now() - hit.at < 30_000) return hit.agent;
  const s = await col.agent(id).get();
  if (!s.exists) return null;
  const agent = withDefaults(AGENT_DEFAULTS as any, s.data()) as Agent;
  agent.id = s.id;
  cache.set(id, { at: Date.now(), agent });
  return agent;
}

export async function getAgentBySlug(slug: string): Promise<Agent | null> {
  const q = await col.agents().where('slug', '==', slug).limit(1).get();
  if (q.empty) return null;
  return getAgent(q.docs[0].id);
}

export function invalidateAgent(id: string) {
  cache.delete(id);
}

export async function getSite(agentId: string, key?: string | null): Promise<Site | null> {
  if (!key) return null;
  const q = await col.sites(agentId).where('key', '==', key).limit(1).get();
  if (q.empty) return null;
  const s = { id: q.docs[0].id, ...(q.docs[0].data() as any) } as Site;
  return s.enabled === false ? null : s;
}
