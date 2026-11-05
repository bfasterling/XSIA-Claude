import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { config } from '../config.js';

if (!getApps().length) {
  initializeApp({ credential: applicationDefault(), projectId: config.projectId || undefined });
}

export const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });
export const auth = getAuth();
export { FieldValue, Timestamp };

export const col = {
  users: () => db.collection('users'),
  agents: () => db.collection('agents'),
  agent: (id: string) => db.collection('agents').doc(id),
  sites: (agentId: string) => db.collection('agents').doc(agentId).collection('sites'),
  documents: (agentId: string) => db.collection('agents').doc(agentId).collection('documents'),
  datasets: (agentId: string) => db.collection('agents').doc(agentId).collection('datasets'),
  media: (agentId: string) => db.collection('agents').doc(agentId).collection('media'),
  webSources: (agentId: string) => db.collection('agents').doc(agentId).collection('webSources'),
  stats: (agentId: string) => db.collection('agents').doc(agentId).collection('stats'),
  chunks: () => db.collection('chunks'),
  sessions: () => db.collection('sessions'),
  messages: (sessionId: string) => db.collection('sessions').doc(sessionId).collection('messages'),
  actionLogs: () => db.collection('actionLogs'),
  waLines: () => db.collection('waLines'),
  waContacts: () => db.collection('waContacts'),
  waMessages: () => db.collection('waMessages'),
  waInbound: () => db.collection('waInbound'),
  campaigns: () => db.collection('campaigns'),
  campaign: (id: string) => db.collection('campaigns').doc(id),
  leads: (campaignId: string) => db.collection('campaigns').doc(campaignId).collection('leads'),
  batches: (campaignId: string) => db.collection('campaigns').doc(campaignId).collection('batches'),
  executions: (campaignId: string) => db.collection('campaigns').doc(campaignId).collection('executions'),
  attempts: (campaignId: string) => db.collection('campaigns').doc(campaignId).collection('attempts'),
  suppressions: () => db.collection('suppressions'),
  dealers: () => db.collection('dealers'),
  lineUsage: () => db.collection('lineUsage'),
};

export function nowTs() {
  return Timestamp.now();
}

export function toDate(v: any): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === 'function') return v.toDate();
  if (typeof v === 'string' || typeof v === 'number') return new Date(v);
  return null;
}

/** Convierte Timestamps a ISO para respuestas JSON */
export function serialize<T = any>(data: any): T {
  if (data === null || data === undefined) return data;
  if (data instanceof Timestamp) return data.toDate().toISOString() as any;
  if (Array.isArray(data)) return data.map((d) => serialize(d)) as any;
  if (typeof data === 'object') {
    if (typeof (data as any).toDate === 'function') return (data as any).toDate().toISOString();
    // Vectores de Firestore no se envían al cliente
    if (data.constructor && data.constructor.name === 'VectorValue') return undefined as any;
    const out: any = {};
    for (const [k, v] of Object.entries(data)) out[k] = serialize(v);
    return out;
  }
  return data;
}

export function docData<T = any>(snap: FirebaseFirestore.DocumentSnapshot): (T & { id: string }) | null {
  if (!snap.exists) return null;
  return { id: snap.id, ...(snap.data() as any) };
}
