import { col, toDate } from '../lib/firestore.js';
import { normalizeSearch } from '../lib/utils.js';

export interface MediaItem {
  id: string;
  name: string;
  description: string;
  tags: string[];
  url: string;
  mimeType: string;
  expiresAt?: any;
  enabled: boolean;
}

const cache = new Map<string, { items: MediaItem[]; at: number }>();

export function invalidateMediaCache(agentId: string) {
  cache.delete(agentId);
}

/** Recursos habilitados y vigentes del agente (respeta vencimientos) */
export async function activeMedia(agentId: string): Promise<MediaItem[]> {
  const hit = cache.get(agentId);
  let items: MediaItem[];
  if (hit && Date.now() - hit.at < 60_000) items = hit.items;
  else {
    const snap = await col.media(agentId).where('enabled', '==', true).get();
    items = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
    cache.set(agentId, { items, at: Date.now() });
  }
  const now = Date.now();
  return items.filter((m) => {
    const exp = toDate(m.expiresAt);
    return !exp || exp.getTime() > now;
  });
}

/**
 * Búsqueda de medios: se devuelven candidatos con descripción para que Claude elija
 * en función del contexto de la conversación (modelo/versión tratados).
 */
export async function searchMedia(agentId: string, query: string, limit = 12) {
  const items = await activeMedia(agentId);
  const terms = normalizeSearch(query)
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const scored = items
    .map((m) => {
      const hay = normalizeSearch(`${m.name} ${m.description} ${(m.tags || []).join(' ')}`);
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
      return { m, score };
    })
    .filter((x) => x.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map(({ m }) => ({ id: m.id, name: m.name, description: m.description, tags: m.tags, type: m.mimeType }));
}
