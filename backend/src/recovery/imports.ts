import ExcelJS from 'exceljs';
import { col, db, FieldValue, Timestamp } from '../lib/firestore.js';
import { downloadBuffer } from '../lib/storage.js';
import { normalizePhone, normalizeSearch, searchTokens } from '../lib/utils.js';
import { parseCsv } from '../rag/datasets.js';
import { cellToString } from '../rag/parsers.js';
import { suppressedSet } from './suppression.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import type { LeadType } from '../types.js';

export const LEAD_FIELDS: Array<{ key: string; label: string; group: string; required?: boolean; synonyms: string[] }> = [
  { key: 'sourceId', label: 'ID original del lead', group: 'Identificación', synonyms: ['lead id', 'leadid', 'id', 'id lead', 'folio'] },
  { key: 'firstName', label: 'Nombre', group: 'Identificación', synonyms: ['nombre', 'first name', 'firstname', 'name', 'nombres'] },
  { key: 'lastName', label: 'Apellidos', group: 'Identificación', synonyms: ['apellido', 'apellidos', 'last name', 'lastname'] },
  { key: 'phone', label: 'Teléfono', group: 'Contacto', required: true, synonyms: ['telefono', 'teléfono', 'phone', 'celular', 'movil', 'whatsapp', 'tel'] },
  { key: 'email', label: 'Correo', group: 'Contacto', synonyms: ['email', 'correo', 'mail', 'e-mail'] },
  { key: 'type', label: 'Tipo de lead', group: 'Clasificación', synonyms: ['tipo', 'type', 'lead type', 'estatus', 'status', 'categoria'] },
  { key: 'reason', label: 'Motivo de abandono/rechazo', group: 'Clasificación', synonyms: ['motivo', 'razon', 'reason', 'rejection reason'] },
  { key: 'zip', label: 'Código postal', group: 'Ubicación', synonyms: ['cp', 'codigo postal', 'zip', 'postal code', 'zipcode'] },
  { key: 'brand', label: 'Marca', group: 'Interés', synonyms: ['marca', 'brand', 'make'] },
  { key: 'model', label: 'Modelo/producto', group: 'Interés', synonyms: ['modelo', 'model', 'vehiculo', 'producto'] },
  { key: 'version', label: 'Versión', group: 'Interés', synonyms: ['version', 'versión', 'trim'] },
  { key: 'year', label: 'Año', group: 'Interés', synonyms: ['año', 'anio', 'year', 'model year'] },
  { key: 'originalDealerId', label: 'ID distribuidor original', group: 'Distribuidor', synonyms: ['dealer id', 'dealer code', 'id distribuidor', 'codigo distribuidor', 'dealerid'] },
  { key: 'originalDealerName', label: 'Nombre distribuidor original', group: 'Distribuidor', synonyms: ['dealer', 'distribuidor', 'dealer name', 'agencia'] },
  { key: 'originalDate', label: 'Fecha original del lead', group: 'Historial', synonyms: ['fecha', 'date', 'created', 'fecha lead', 'created date'] },
  { key: 'summary', label: 'Resumen de interacción previa', group: 'Historial', synonyms: ['resumen', 'summary', 'comentarios', 'notas', 'historial'] },
  { key: 'consentWhatsApp', label: 'Consentimiento WhatsApp', group: 'Consentimiento', synonyms: ['consentimiento', 'opt in', 'optin', 'consent'] },
  { key: 'doNotContact', label: 'No contactar / opt-out', group: 'Consentimiento', synonyms: ['no contactar', 'opt out', 'optout', 'dnc', 'do not contact'] },
];

export async function readTable(buf: Buffer, filename: string): Promise<{ columns: string[]; rows: Record<string, any>[] }> {
  if (/\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const ws = wb.worksheets[0];
    if (!ws) return { columns: [], rows: [] };
    const header = (ws.getRow(1).values as any[]).slice(1).map((v) => cellToString(v).trim());
    const rows: Record<string, any>[] = [];
    ws.eachRow((row, i) => {
      if (i === 1) return;
      const vals = (row.values as any[]).slice(1);
      const r: Record<string, any> = {};
      header.forEach((h, j) => (r[h] = cellToString(vals[j]).trim()));
      if (Object.values(r).some((v) => v)) rows.push(r);
    });
    return { columns: header.filter(Boolean), rows };
  }
  if (/\.xls$/i.test(filename)) throw new Error('Formato .xls no soportado; guarda el archivo como .xlsx o .csv');
  return parseCsv(buf);
}

export function suggestMapping(columns: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const used = new Set<string>();
  for (const f of LEAD_FIELDS) {
    const c = columns.find((col) => {
      const n = normalizeSearch(col).replace(/[_-]/g, ' ');
      return !used.has(col) && (n === f.key.toLowerCase() || f.synonyms.some((s) => n === s || n.includes(s)));
    });
    if (c) {
      map[f.key] = c;
      used.add(c);
    }
  }
  return map;
}

export function parseLeadType(v: any, fixed?: LeadType | null): LeadType | null {
  if (fixed) return fixed;
  const s = normalizeSearch(String(v || '')).replace(/[_-]/g, ' ');
  if (!s) return null;
  if (/(no contact|not contact|sin atencion|no atendid|uncontact|sin contacto)/.test(s)) return 'NOT_CONTACTED';
  if (/(abandon)/.test(s)) return 'ABANDONED';
  if (/(rechaz|reject|declin)/.test(s)) return 'REJECTED';
  return null;
}

const truthy = (v: any) => ['1', 'si', 'sí', 'true', 'yes', 'y', 'x'].includes(normalizeSearch(String(v ?? '')));
const falsy = (v: any) => ['0', 'no', 'false', 'n'].includes(normalizeSearch(String(v ?? '')));

function parseDate(v: any): number {
  if (!v) return 0;
  const s = String(v);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return new Date(Number(m[3].length === 2 ? '20' + m[3] : m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}

/**
 * Tarea de importación: mapea columnas, normaliza teléfonos, deduplica (teléfono único,
 * conserva el lead más reciente), aplica supresiones y calcula elegibilidad.
 */
export async function importLeadsTask(p: { campaignId: string; batchId: string }) {
  const batchRef = col.batches(p.campaignId).doc(p.batchId);
  const batch: any = (await batchRef.get()).data();
  if (!batch || batch.status === 'done') return;
  await batchRef.update({ status: 'processing', startedAt: FieldValue.serverTimestamp() });
  try {
    const buf = await downloadBuffer(batch.gcsPath);
    const { rows: all } = await readTable(buf, batch.fileName);
    const truncated = all.length > config.recovery.maxImportRows;
    const rows = all.slice(0, config.recovery.maxImportRows);
    const mapping: Record<string, string> = batch.mapping || {};
    const get = (r: any, k: string) => (mapping[k] ? String(r[mapping[k]] ?? '').trim() : '');

    const stats = { total: rows.length, accepted: 0, eligible: 0, invalidPhone: 0, duplicatesInFile: 0, duplicatesInCampaign: 0, suppressed: 0, invalidType: 0, ineligible: 0 };
    const errors: Array<{ row: number; reason: string; phone?: string }> = [];
    const byPhone = new Map<string, { row: number; data: any; date: number }>();

    rows.forEach((r, i) => {
      const phone = normalizePhone(get(r, 'phone'));
      if (!phone) {
        stats.invalidPhone++;
        if (errors.length < 500) errors.push({ row: i + 2, reason: 'Teléfono inválido o vacío', phone: get(r, 'phone') });
        return;
      }
      const type = parseLeadType(get(r, 'type'), batch.fixedType || null);
      if (!type) {
        stats.invalidType++;
        if (errors.length < 500) errors.push({ row: i + 2, reason: `Tipo de lead no reconocido: "${get(r, 'type')}"`, phone });
        return;
      }
      const date = parseDate(get(r, 'originalDate'));
      const prev = byPhone.get(phone);
      if (prev) {
        stats.duplicatesInFile++;
        if (date < prev.date) return; // conserva el más reciente
      }
      byPhone.set(phone, { row: i + 2, date, data: { r, phone, type } });
    });

    const phones = [...byPhone.keys()];
    const suppressed = await suppressedSet(phones);
    // existentes en la campaña
    const existing = new Set<string>();
    for (let i = 0; i < phones.length; i += 100) {
      const refs = phones.slice(i, i + 100).map((ph) => col.leads(p.campaignId).doc(ph));
      if (refs.length) (await db.getAll(...refs)).forEach((s) => s.exists && existing.add(s.id));
    }

    const writer = db.bulkWriter();
    const now = Timestamp.now();
    for (const [phone, { data }] of byPhone) {
      if (existing.has(phone)) {
        stats.duplicatesInCampaign++;
        continue;
      }
      const r = data.r;
      const consentRaw = get(r, 'consentWhatsApp');
      const dncRaw = get(r, 'doNotContact');
      const consent = consentRaw ? (truthy(consentRaw) ? true : falsy(consentRaw) ? false : null) : null;
      const dnc = dncRaw ? truthy(dncRaw) : false;
      let reason: string | null = null;
      if (suppressed.has(phone)) reason = 'SUPPRESSED';
      else if (dnc) reason = 'DO_NOT_CONTACT';
      else if (consent === false) reason = 'NO_CONSENT';
      if (reason === 'SUPPRESSED') stats.suppressed++;
      else if (reason) stats.ineligible++;
      const lead = {
        campaignId: p.campaignId,
        sourceId: get(r, 'sourceId') || null,
        firstName: get(r, 'firstName'),
        lastName: get(r, 'lastName'),
        phone,
        email: get(r, 'email').toLowerCase() || null,
        zip: get(r, 'zip') || null,
        type: data.type,
        reason: get(r, 'reason') || null,
        brand: get(r, 'brand') || null,
        model: get(r, 'model') || null,
        version: get(r, 'version') || null,
        year: get(r, 'year') || null,
        originalDealerId: get(r, 'originalDealerId') || null,
        originalDealerName: get(r, 'originalDealerName') || null,
        originalDate: get(r, 'originalDate') || null,
        summary: get(r, 'summary') || null,
        consentWhatsApp: consent,
        doNotContact: dnc,
        eligible: !reason,
        ineligibleReason: reason,
        batchId: p.batchId,
        batchName: batch.name,
        importedAt: now,
        nextAttemptAt: now,
        status: 'PENDING',
        outcome: null,
        attempts: 0,
        searchTokens: searchTokens(get(r, 'firstName'), get(r, 'lastName'), phone, get(r, 'email'), get(r, 'sourceId')),
      };
      writer.create(col.leads(p.campaignId).doc(phone), lead).catch(() => {
        stats.duplicatesInCampaign++;
        stats.accepted--;
        if (!reason) stats.eligible--;
      });
      stats.accepted++;
      if (!reason) stats.eligible++;
    }
    await writer.close();

    await batchRef.update({
      status: 'done',
      stats,
      truncated,
      totalInFile: all.length,
      errors: errors.slice(0, 500),
      finishedAt: FieldValue.serverTimestamp(),
    });
    await col.campaign(p.campaignId).update({
      'counters.leads': FieldValue.increment(stats.accepted),
      'counters.eligible': FieldValue.increment(stats.eligible),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (e: any) {
    logger.error('Importación falló', { ...p, error: e });
    await batchRef.update({ status: 'error', error: String(e?.message || e) });
  }
}
