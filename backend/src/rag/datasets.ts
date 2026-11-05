import { parse } from 'csv-parse/sync';
import { col, FieldValue } from '../lib/firestore.js';
import { uploadBuffer, downloadBuffer } from '../lib/storage.js';
import { structured } from '../lib/claude.js';
import { normalizeSearch } from '../lib/utils.js';

/**
 * Bases de información estructurada (CSV) consultables por el agente.
 * Las filas se guardan como JSON en Cloud Storage y se consultan en memoria
 * mediante la herramienta "consultar_base_datos" (filtros que Claude construye).
 */
export interface DatasetColumn {
  name: string;
  type: 'string' | 'number' | 'date';
  description: string;
}

export function parseCsv(buf: Buffer): { columns: string[]; rows: Record<string, any>[] } {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delimiter = [',', ';', '\t', '|'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = parse(text, { columns: true, skip_empty_lines: true, delimiter, relax_column_count: true, trim: true }) as Record<string, any>[];
  const columns = rows.length ? Object.keys(rows[0]) : firstLine.split(delimiter);
  return { columns, rows };
}

function inferType(values: any[]): DatasetColumn['type'] {
  const sample = values.filter((v) => v !== '' && v != null).slice(0, 50);
  if (sample.length && sample.every((v) => !isNaN(Number(String(v).replace(/[$,\s]/g, ''))))) return 'number';
  if (sample.length && sample.every((v) => /^\d{4}-\d{2}-\d{2}/.test(String(v)) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(String(v))))
    return 'date';
  return 'string';
}

export async function createDataset(agentId: string, name: string, purpose: string, buf: Buffer, filename: string) {
  const { columns, rows } = parseCsv(buf);
  if (!rows.length) throw new Error('El CSV no contiene filas');
  const cols: DatasetColumn[] = columns.map((c) => ({ name: c, type: inferType(rows.map((r) => r[c])), description: '' }));
  // Claude sugiere descripciones por campo (el administrador puede editarlas)
  try {
    const { data } = await structured<{ columns: Array<{ name: string; description: string }> }>({
      prompt: `Base de datos "${name}". Propósito: ${purpose || 'n/d'}.\nColumnas: ${columns.join(', ')}\nEjemplos:\n${JSON.stringify(rows.slice(0, 5))}\n\nDescribe brevemente en español qué contiene cada columna, para que un asistente sepa cómo filtrarla.`,
      schema: {
        type: 'object',
        properties: {
          columns: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'description'] },
          },
        },
        required: ['columns'],
      },
    });
    for (const c of data.columns || []) {
      const t = cols.find((x) => x.name === c.name);
      if (t) t.description = c.description;
    }
  } catch {
    /* opcional */
  }
  const ref = col.datasets(agentId).doc();
  const gcsPath = await uploadBuffer(`agents/${agentId}/datasets/${ref.id}.json`, Buffer.from(JSON.stringify(rows)), 'application/json');
  await ref.set({
    name,
    purpose,
    fileName: filename,
    columns: cols,
    rowCount: rows.length,
    gcsPath,
    enabled: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

const cache = new Map<string, { rows: any[]; version: string; at: number }>();

async function loadRows(agentId: string, ds: any): Promise<any[]> {
  const key = `${agentId}/${ds.id}`;
  const version = String(ds.gcsPath) + String(ds.rowCount);
  const hit = cache.get(key);
  if (hit && hit.version === version && Date.now() - hit.at < 30 * 60_000) return hit.rows;
  const rows = JSON.parse((await downloadBuffer(ds.gcsPath)).toString('utf8'));
  cache.set(key, { rows, version, at: Date.now() });
  if (cache.size > 50) cache.delete(cache.keys().next().value as string);
  return rows;
}

export interface DatasetFilter {
  field: string;
  op: 'eq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'neq';
  value: string | number;
}

const toNum = (v: any) => Number(String(v).replace(/[$,\s]/g, ''));

export async function queryDataset(
  agentId: string,
  datasetId: string,
  filters: DatasetFilter[] = [],
  limit = 20,
  fields?: string[],
  sortBy?: { field: string; dir: 'asc' | 'desc' },
) {
  const snap = await col.datasets(agentId).doc(datasetId).get();
  if (!snap.exists) throw new Error('Base de datos no encontrada');
  const ds: any = { id: snap.id, ...snap.data() };
  if (!ds.enabled) throw new Error('Base de datos deshabilitada');
  const rows = await loadRows(agentId, ds);
  const match = (r: any, f: DatasetFilter) => {
    const v = r[f.field];
    if (v === undefined) return false;
    switch (f.op) {
      case 'eq':
        return normalizeSearch(String(v)) === normalizeSearch(String(f.value));
      case 'neq':
        return normalizeSearch(String(v)) !== normalizeSearch(String(f.value));
      case 'contains':
        return normalizeSearch(String(v)).includes(normalizeSearch(String(f.value)));
      case 'gt':
        return toNum(v) > toNum(f.value);
      case 'gte':
        return toNum(v) >= toNum(f.value);
      case 'lt':
        return toNum(v) < toNum(f.value);
      case 'lte':
        return toNum(v) <= toNum(f.value);
    }
  };
  let res = rows.filter((r) => filters.every((f) => match(r, f)));
  const total = res.length;
  if (sortBy?.field) {
    const col0 = (ds.columns as DatasetColumn[]).find((c) => c.name === sortBy.field);
    res = [...res].sort((a, b) => {
      const x = col0?.type === 'number' ? toNum(a[sortBy.field]) : String(a[sortBy.field]);
      const y = col0?.type === 'number' ? toNum(b[sortBy.field]) : String(b[sortBy.field]);
      return (x > y ? 1 : x < y ? -1 : 0) * (sortBy.dir === 'desc' ? -1 : 1);
    });
  }
  res = res.slice(0, Math.min(limit, 100));
  if (fields?.length) res = res.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]])));
  return { dataset: ds.name, total, returned: res.length, rows: res };
}
