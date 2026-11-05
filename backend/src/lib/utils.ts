import crypto from 'node:crypto';
import { config } from '../config.js';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function newId(prefix = ''): string {
  return prefix + crypto.randomBytes(10).toString('hex');
}

export function sha256(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function slugify(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Nombre válido para herramienta de Claude: ^[a-zA-Z0-9_-]{1,64}$ */
export function toolName(prefix: string, name: string): string {
  const base = slugify(name).replace(/-/g, '_') || 'tool';
  return `${prefix}_${base}`.slice(0, 64);
}

/**
 * Normaliza teléfonos a formato E.164 sin "+".
 * México: WhatsApp a veces reporta 521XXXXXXXXXX; se normaliza a 52XXXXXXXXXX.
 */
export function normalizePhone(raw: any, cc = config.recovery.defaultCountryCode): string | null {
  if (raw === null || raw === undefined) return null;
  let d = String(raw).replace(/\.0+$/, '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (cc === '52') {
    if (d.length === 13 && d.startsWith('521')) d = '52' + d.slice(3);
    if (d.length === 10) d = '52' + d;
    if (d.length === 12 && d.startsWith('52')) return d;
    return null;
  }
  if (d.length === 10) d = cc + d;
  if (d.length < 11 || d.length > 15) return null;
  return d;
}

/** Divide texto en fragmentos por párrafos con traslape */
export function chunkText(text: string, size = config.rag.chunkSize, overlap = config.rag.chunkOverlap): string[] {
  const clean = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const paras = clean.split(/\n\n+/);
  const chunks: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) chunks.push(cur.trim());
  };
  for (const p of paras) {
    if (p.length > size) {
      // párrafo muy largo: cortar por oraciones
      const sentences = p.split(/(?<=[.!?;])\s+/);
      for (const s of sentences) {
        if ((cur + ' ' + s).length > size) {
          push();
          cur = cur.slice(-overlap) + ' ' + s;
        } else cur += (cur ? ' ' : '') + s;
      }
      continue;
    }
    if ((cur + '\n\n' + p).length > size) {
      push();
      cur = cur.slice(-overlap) + '\n\n' + p;
    } else cur += (cur ? '\n\n' : '') + p;
  }
  push();
  // corta cualquier fragmento que siga excediendo (texto sin puntuación)
  return chunks.flatMap((c) => {
    if (c.length <= size * 1.5) return [c];
    const out: string[] = [];
    for (let i = 0; i < c.length; i += size - overlap) out.push(c.slice(i, i + size));
    return out;
  });
}

export function getPath(obj: any, path?: string): any {
  if (!path) return undefined;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Sustituye {{a.b}} en un template. jsonSafe escapa para insertarse dentro de strings JSON */
export function renderTemplate(tpl: string, vars: Record<string, any>, jsonSafe = false): string {
  return (tpl || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => {
    const v = getPath(vars, key);
    if (v === undefined || v === null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return jsonSafe ? JSON.stringify(s).slice(1, -1) : s;
  });
}

export function truncate(s: string, max: number) {
  if (!s) return s;
  return s.length > max ? s.slice(0, max) + '…[truncado]' : s;
}

export function stringifyForModel(v: any, max = 12000): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 0);
  return truncate(s, max);
}

/** Tokens para búsqueda simple por array-contains en Firestore */
export function searchTokens(...values: Array<string | undefined | null>): string[] {
  const set = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    const norm = String(v)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
    set.add(norm.trim());
    for (const t of norm.split(/[\s,;]+/)) if (t.length >= 2) set.add(t);
    const digits = norm.replace(/\D/g, '');
    if (digits.length >= 7) {
      set.add(digits);
      set.add(digits.slice(-10));
    }
  }
  return [...set].slice(0, 40);
}

export function normalizeSearch(q: string) {
  return q
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function dayKey(d = new Date(), tz = config.defaultTimezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Hora y día de la semana (0=domingo) en una zona horaria */
export function zonedParts(d: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hourCycle: 'h23',
    weekday: 'short',
    minute: 'numeric',
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  return { hour, minute, day };
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

export function maskSecret(s?: string) {
  if (!s) return '';
  return s.length <= 8 ? '••••' : s.slice(0, 4) + '••••' + s.slice(-4);
}
