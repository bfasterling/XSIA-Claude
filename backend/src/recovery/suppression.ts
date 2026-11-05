import { col, FieldValue } from '../lib/firestore.js';
import { normalizePhone } from '../lib/utils.js';

/** Lista global de supresión (no contactar). Afecta a todas las campañas. */
export async function suppress(phoneRaw: string, reason: string, source: string, by?: string) {
  const phone = normalizePhone(phoneRaw) || phoneRaw;
  await col.suppressions().doc(phone).set(
    { phone, reason, source, createdBy: by || null, createdAt: FieldValue.serverTimestamp(), active: true },
    { merge: true },
  );
  return phone;
}

export async function unsuppress(phone: string, by: string) {
  await col.suppressions().doc(phone).set({ active: false, removedBy: by, removedAt: FieldValue.serverTimestamp() }, { merge: true });
}

export async function isSuppressed(phone: string): Promise<boolean> {
  const s = await col.suppressions().doc(phone).get();
  return s.exists && (s.data() as any).active !== false;
}

/** Consulta en lote (máx. 100 por llamada getAll) */
export async function suppressedSet(phones: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < phones.length; i += 100) {
    const refs = phones.slice(i, i + 100).map((p) => col.suppressions().doc(p));
    if (!refs.length) continue;
    const snaps = await col.suppressions().firestore.getAll(...refs);
    snaps.forEach((s) => {
      if (s.exists && (s.data() as any).active !== false) out.add(s.id);
    });
  }
  return out;
}
