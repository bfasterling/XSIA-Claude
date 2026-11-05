import { col } from '../lib/firestore.js';
import { config } from '../config.js';
import { fetchWithTimeout, readBody } from '../lib/http.js';
import { haversineKm, normalizeSearch, renderTemplate } from '../lib/utils.js';
import { logger } from '../lib/logger.js';
import type { Agent, Dealer } from '../types.js';

/**
 * Directorio de distribuidores (Dealer Locator).
 *  - internal: colección "dealers" de Firestore + geocodificación con Google Maps Geocoding API
 *  - external: servicio externo configurado por agente
 * Regla funcional: la ubicación expresada por el cliente tiene prioridad sobre la del distribuidor original.
 */
export interface DealerQuery {
  postalCode?: string;
  city?: string;
  state?: string;
  brand?: string;
  count?: number;
  excludeIds?: string[];
}

let dealerCache: { at: number; items: Dealer[] } | null = null;
async function allDealers(): Promise<Dealer[]> {
  if (dealerCache && Date.now() - dealerCache.at < 10 * 60_000) return dealerCache.items;
  const snap = await col.dealers().get();
  dealerCache = { at: Date.now(), items: snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) };
  return dealerCache.items;
}
export function invalidateDealerCache() {
  dealerCache = null;
}

const geoCache = new Map<string, { lat: number; lng: number; formatted: string } | null>();
export async function geocode(address: string): Promise<{ lat: number; lng: number; formatted: string } | null> {
  if (!config.google.mapsApiKey) return null;
  const key = normalizeSearch(address);
  if (geoCache.has(key)) return geoCache.get(key)!;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&region=mx&language=es&key=${config.google.mapsApiKey}`;
    const res = await fetchWithTimeout(url, { timeoutMs: 8000 });
    const json: any = await res.json();
    const r = json.results?.[0];
    const val = r ? { lat: r.geometry.location.lat, lng: r.geometry.location.lng, formatted: r.formatted_address } : null;
    geoCache.set(key, val);
    return val;
  } catch (e) {
    logger.warn('Geocoding falló', { error: e });
    return null;
  }
}

export async function findDealers(agent: Agent, q: DealerQuery) {
  const count = Math.min(q.count || agent.dealers?.defaultCount || 3, 10);
  const exclude = new Set((q.excludeIds || []).map(String));
  const brand = q.brand || agent.dealers?.brandFilter || '';

  if (agent.dealers?.mode === 'external' && agent.dealers.externalUrl) {
    const vars = { postalCode: q.postalCode || '', city: q.city || '', state: q.state || '', brand, count };
    const url = renderTemplate(agent.dealers.externalUrl, vars);
    const res = await fetchWithTimeout(url, {
      method: agent.dealers.externalMethod || 'GET',
      headers: { 'Content-Type': 'application/json', ...(agent.dealers.headers || {}) },
      body: agent.dealers.externalMethod === 'POST' ? JSON.stringify(vars) : undefined,
      timeoutMs: 15000,
    });
    const body = await readBody(res);
    if (!res.ok) return { ok: false, error: `Directorio respondió ${res.status}`, dealers: [] };
    const list: any[] = Array.isArray(body) ? body : body.dealers || body.data || body.results || [];
    const dealers = list
      .map((d) => ({
        id: String(d.id ?? d.code ?? d.dealerCode ?? d.dealer_id ?? ''),
        name: d.name ?? d.dealerName ?? d.nombre,
        address: d.address ?? d.direccion,
        city: d.city ?? d.ciudad,
        phone: d.phone ?? d.telefono,
        distanceKm: d.distance ?? d.distanceKm,
      }))
      .filter((d) => d.id && !exclude.has(d.id))
      .slice(0, count);
    return { ok: true, reference: vars, dealers };
  }

  // Directorio interno
  let items = (await allDealers()).filter((d) => !exclude.has(String(d.id)));
  if (brand) {
    const b = normalizeSearch(brand);
    const filtered = items.filter((d) => !d.brand || normalizeSearch(d.brand).includes(b) || b.includes(normalizeSearch(d.brand)));
    if (filtered.length) items = filtered;
  }
  const address = [q.postalCode, q.city, q.state].filter(Boolean).join(', ');
  const geo = address ? await geocode(`${address}, México`) : null;
  if (geo) {
    const ranked = items
      .filter((d) => typeof d.lat === 'number' && typeof d.lng === 'number')
      .map((d) => ({ ...d, distanceKm: Math.round(haversineKm(geo, { lat: d.lat!, lng: d.lng! }) * 10) / 10 }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, count);
    return { ok: true, reference: { address, resolvedAs: geo.formatted }, dealers: ranked.map(slim) };
  }
  // Sin geocodificación: coincidencia por ciudad/estado o prefijo de CP
  const city = normalizeSearch(q.city || '');
  const state = normalizeSearch(q.state || '');
  const cp = (q.postalCode || '').replace(/\D/g, '');
  const scored = items
    .map((d) => {
      let s = 0;
      if (city && normalizeSearch(d.city || '').includes(city)) s += 5;
      if (state && normalizeSearch(d.state || '').includes(state)) s += 2;
      if (cp && d.zip) {
        const z = String(d.zip);
        if (z === cp) s += 6;
        else if (z.slice(0, 3) === cp.slice(0, 3)) s += 4;
        else if (z.slice(0, 2) === cp.slice(0, 2)) s += 3;
      }
      return { d, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, count)
    .map((x) => slim(x.d));
  return {
    ok: scored.length > 0,
    reference: { address },
    dealers: scored,
    note: scored.length ? 'Coincidencia por ciudad/CP (sin geocodificación)' : 'No se encontraron distribuidores para esa ubicación',
  };
}

function slim(d: any) {
  return { id: d.id, name: d.name, address: d.address, city: d.city, state: d.state, phone: d.phone, distanceKm: d.distanceKm };
}
