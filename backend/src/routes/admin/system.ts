import type { FastifyInstance } from 'fastify';
import { col, db, FieldValue, serialize } from '../../lib/firestore.js';
import { badRequest } from '../../lib/http.js';
import { normalizePhone, normalizeSearch } from '../../lib/utils.js';
import { suppress, unsuppress } from '../../recovery/suppression.js';
import { parseCsv } from '../../rag/datasets.js';
import { invalidateDealerCache, geocode } from '../../chat/dealers.js';
import { guard } from './guard.js';

export async function systemRoutes(app: FastifyInstance) {
  /* ---------------- Lista de supresión ---------------- */
  app.get('/suppressions', async (req) => {
    const q = req.query as any;
    if (q.phone) {
      const p = normalizePhone(q.phone) || q.phone;
      const s = await col.suppressions().doc(p).get();
      return s.exists ? [serialize({ id: s.id, ...s.data() })] : [];
    }
    const snap = await col.suppressions().where('active', '==', true).orderBy('createdAt', 'desc').limit(Math.min(Number(q.limit) || 200, 1000)).get();
    return snap.docs.map((d) => serialize({ id: d.id, ...d.data() }));
  });
  app.post('/suppressions', async (req) => {
    const b = (req.body || {}) as any;
    const phones: string[] = (Array.isArray(b.phones) ? b.phones : [b.phone]).filter(Boolean);
    const out: string[] = [];
    for (const p of phones) {
      const n = normalizePhone(p);
      if (n) out.push(await suppress(n, b.reason || 'Alta manual', `admin:${req.user.email}`, req.user.email));
    }
    if (!out.length) throw badRequest('Ningún teléfono válido');
    return { added: out.length };
  });
  app.delete('/suppressions/:phone', { preHandler: guard('admin') }, async (req) => {
    await unsuppress((req.params as any).phone, req.user.email);
    return { ok: true };
  });

  /* ---------------- Directorio de distribuidores ---------------- */
  app.get('/dealers', async (req) => {
    const q = req.query as any;
    const snap = await col.dealers().limit(Math.min(Number(q.limit) || 500, 5000)).get();
    let items = snap.docs.map((d) => serialize({ id: d.id, ...d.data() }));
    if (q.search) {
      const s = normalizeSearch(q.search);
      items = items.filter((d: any) => normalizeSearch(`${d.id} ${d.name} ${d.city} ${d.state} ${d.brand}`).includes(s));
    }
    return items;
  });

  /**
   * Importa distribuidores desde CSV. Columnas esperadas: code,name,brand,type,address,city,state,zip,lat,lng,phone,url.
   * Si faltan lat/lng y hay GOOGLE_MAPS_API_KEY, se geocodifica la dirección.
   */
  app.post('/dealers/import', async (req) => {
    const file = await (req as any).file();
    if (!file) throw badRequest('CSV requerido');
    const { rows } = parseCsv(await file.toBuffer());
    const pick = (r: any, ...keys: string[]) => {
      for (const k of Object.keys(r)) if (keys.includes(normalizeSearch(k))) return String(r[k] ?? '').trim();
      return '';
    };
    const w = db.bulkWriter();
    let n = 0;
    let geocoded = 0;
    for (const r of rows) {
      const code = pick(r, 'code', 'codigo', 'id', 'dealer code', 'dealerid', 'clave');
      const name = pick(r, 'name', 'nombre', 'dealer');
      if (!code || !name) continue;
      let lat = Number(pick(r, 'lat', 'latitude', 'latitud')) || undefined;
      let lng = Number(pick(r, 'lng', 'lon', 'longitude', 'longitud')) || undefined;
      const d: any = {
        name,
        brand: pick(r, 'brand', 'marca'),
        type: pick(r, 'type', 'tipo'),
        address: pick(r, 'address', 'direccion'),
        city: pick(r, 'city', 'ciudad', 'municipio'),
        state: pick(r, 'state', 'estado'),
        zip: pick(r, 'zip', 'cp', 'codigo postal'),
        phone: pick(r, 'phone', 'telefono'),
        url: pick(r, 'url', 'web', 'sitio'),
      };
      if ((!lat || !lng) && n < 2000) {
        const g = await geocode([d.address, d.zip, d.city, d.state, 'México'].filter(Boolean).join(', '));
        if (g) {
          lat = g.lat;
          lng = g.lng;
          geocoded++;
        }
      }
      w.set(col.dealers().doc(code.replace(/\//g, '-')), { ...d, lat: lat ?? null, lng: lng ?? null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      n++;
    }
    await w.close();
    invalidateDealerCache();
    return { imported: n, geocoded };
  });
  app.delete('/dealers/:id', { preHandler: guard('admin') }, async (req) => {
    await col.dealers().doc((req.params as any).id).delete();
    invalidateDealerCache();
    return { ok: true };
  });

  /* ---------------- Usuarios y roles ---------------- */
  app.get('/users', { preHandler: guard('admin') }, async () => {
    const snap = await col.users().get();
    return snap.docs.map((d) => serialize({ id: d.id, ...d.data() }));
  });
  app.patch('/users/:uid', { preHandler: guard('admin') }, async (req) => {
    const b = (req.body || {}) as any;
    const patch: any = {};
    if ('role' in b) {
      if (b.role !== null && !['admin', 'operator', 'viewer'].includes(b.role)) throw badRequest('Rol inválido');
      patch.role = b.role;
    }
    if ('disabled' in b) patch.disabled = !!b.disabled;
    await col.users().doc((req.params as any).uid).set(patch, { merge: true });
    return { ok: true };
  });
}
