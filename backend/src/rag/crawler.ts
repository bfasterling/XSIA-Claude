import { col, FieldValue } from '../lib/firestore.js';
import { fetchWithTimeout } from '../lib/http.js';
import { htmlToText } from './parsers.js';
import { indexText } from './ingest.js';
import { mapLimit, sha256 } from '../lib/utils.js';
import { logger } from '../lib/logger.js';
import type { Agent } from '../types.js';

const UA = 'XSIA-Claude-Crawler/1.0 (+knowledge indexing)';

async function getText(url: string) {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml,*/*' }, timeoutMs: 20000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { body: await res.text(), type: res.headers.get('content-type') || '' };
}

/** Lee sitemap.xml (incluye sitemap index) */
async function readSitemap(url: string, max: number, depth = 0): Promise<string[]> {
  try {
    const { body } = await getText(url);
    const locs = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    if (/<sitemapindex/i.test(body) && depth < 2) {
      const out: string[] = [];
      for (const sm of locs) {
        if (out.length >= max) break;
        out.push(...(await readSitemap(sm, max - out.length, depth + 1)));
      }
      return out;
    }
    return locs.slice(0, max);
  } catch {
    return [];
  }
}

/** Recorrido BFS limitado al mismo dominio */
async function discover(start: string, max: number): Promise<string[]> {
  const host = new URL(start).host;
  const seen = new Set<string>([start]);
  const queue = [start];
  const out: string[] = [];
  while (queue.length && out.length < max) {
    const u = queue.shift()!;
    out.push(u);
    try {
      const { body, type } = await getText(u);
      if (!type.includes('html')) continue;
      for (const href of htmlToText(body).links) {
        try {
          const abs = new URL(href, u);
          abs.hash = '';
          if (abs.host !== host || !/^https?:$/.test(abs.protocol)) continue;
          if (/\.(pdf|jpg|jpeg|png|gif|zip|mp4|svg|webp)$/i.test(abs.pathname)) continue;
          const s = abs.toString();
          if (!seen.has(s)) {
            seen.add(s);
            queue.push(s);
          }
        } catch {
          /* enlace inválido */
        }
      }
    } catch {
      /* página no accesible */
    }
  }
  return out;
}

export async function crawlTask({ agentId, sourceId }: { agentId: string; sourceId: string }) {
  const ref = col.webSources(agentId).doc(sourceId);
  const src: any = (await ref.get()).data();
  if (!src) return;
  const agent = { id: agentId, ...((await col.agent(agentId).get()).data() as any) } as Agent;
  const max = Math.min(src.maxPages || 50, 500);
  await ref.update({ status: 'crawling', error: null, startedAt: FieldValue.serverTimestamp() });
  try {
    let urls: string[] = src.urls?.length ? src.urls : [];
    if (!urls.length) {
      const base = new URL(src.url);
      const sitemapUrl = src.sitemapUrl || `${base.origin}/sitemap.xml`;
      urls = await readSitemap(sitemapUrl, max);
      if (src.pathPrefix) urls = urls.filter((u) => new URL(u).pathname.startsWith(src.pathPrefix));
      if (!urls.length) urls = await discover(src.url, max);
    }
    urls = [...new Set(urls)].slice(0, max);
    const failed: Array<{ url: string; error: string }> = [];
    let indexed = 0;
    await mapLimit(urls, 3, async (url) => {
      try {
        const { body, type } = await getText(url);
        if (!type.includes('html')) throw new Error('No es HTML');
        const { text, title } = htmlToText(body);
        if (text.length < 120) throw new Error('Contenido insuficiente o bloqueado para lectura automática');
        const documentId = 'web_' + sha256(agentId + url).slice(0, 24);
        await col.documents(agentId).doc(documentId).set(
          {
            name: title || url,
            title: title || url,
            url,
            sourceType: 'web',
            webSourceId: sourceId,
            status: 'processing',
            createdAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        const n = await indexText({ agent, documentId, title: title || url, text, url, sourceType: 'web' });
        await col.documents(agentId).doc(documentId).update({ status: 'ready', chunks: n, chars: text.length });
        indexed++;
      } catch (e: any) {
        failed.push({ url, error: String(e?.message || e) });
      }
    });
    await ref.update({
      status: 'ready',
      pagesFound: urls.length,
      pagesIndexed: indexed,
      failed: failed.slice(0, 100),
      finishedAt: FieldValue.serverTimestamp(),
    });
  } catch (e: any) {
    logger.error('Crawl falló', { agentId, sourceId, error: e });
    await ref.update({ status: 'error', error: String(e?.message || e) });
  }
}
