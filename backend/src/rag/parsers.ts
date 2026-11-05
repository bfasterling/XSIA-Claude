import * as cheerio from 'cheerio';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
// Importa el módulo interno para evitar el archivo de prueba que pdf-parse lee al cargar index.js
// @ts-ignore
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { claude, textOf } from '../lib/claude.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export interface Extracted {
  text: string;
  title?: string;
  method: string;
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function guessMime(filename: string, mime?: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    html: 'text/html',
    htm: 'text/html',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  if (mime && mime !== 'application/octet-stream') return mime;
  return map[ext] || 'application/octet-stream';
}

/** Usa Claude para leer PDFs escaneados o con tablas complejas */
async function claudeReadPdf(buf: Buffer): Promise<string> {
  const res = await claude().messages.create({
    model: config.claude.fastModel,
    max_tokens: 16000,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } } as any,
          {
            type: 'text',
            text: 'Transcribe el contenido completo de este documento en texto plano en su idioma original. Conserva títulos, listas y tablas (en formato Markdown). No resumas ni agregues comentarios.',
          },
        ],
      },
    ],
  });
  return textOf(res as any);
}

/** Describe una imagen con visión de Claude (para conocimiento o librería de medios) */
export async function claudeDescribeImage(
  buf: Buffer,
  mediaType: string,
  purpose: 'knowledge' | 'media',
  hint = '',
): Promise<{ description: string; tags: string[] }> {
  const prompt =
    purpose === 'knowledge'
      ? 'Extrae todo el texto visible y describe con detalle la información que contiene esta imagen (tablas, precios, especificaciones), en español.'
      : `Describe esta imagen en español para un catálogo que un asistente comercial usará para elegir qué imagen mostrar. Identifica producto, marca, modelo, versión, color, ángulo y contexto si es posible. ${hint ? 'Contexto del archivo: ' + hint : ''}
Responde en JSON: {"description": "1-3 oraciones", "tags": ["etiqueta", ...]}`;
  const res = await claude().messages.create({
    model: config.claude.fastModel,
    max_tokens: 1200,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType as any, data: buf.toString('base64') } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });
  const text = textOf(res as any);
  if (purpose === 'knowledge') return { description: text, tags: [] };
  try {
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    return { description: String(json.description || ''), tags: (json.tags || []).map(String).slice(0, 15) };
  } catch {
    return { description: text.slice(0, 500), tags: [] };
  }
}

export function htmlToText(html: string): { text: string; title: string; links: string[] } {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || $('h1').first().text().trim();
  const links = $('a[href]')
    .map((_i, el) => $(el).attr('href') || '')
    .get();
  $('script,style,noscript,svg,iframe,nav,footer,header,form,[aria-hidden=true]').remove();
  const blocks: string[] = [];
  $('h1,h2,h3,h4,p,li,td,th,dd,dt,blockquote,pre').each((_i, el) => {
    const tag = (el as any).tagName?.toLowerCase();
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (tag?.startsWith('h')) blocks.push(`\n## ${t}`);
    else if (tag === 'li') blocks.push(`- ${t}`);
    else blocks.push(t);
  });
  let text = blocks.join('\n');
  if (text.length < 200) text = $('body').text().replace(/\s+/g, ' ').trim();
  return { text, title, links };
}

async function xlsxToText(buf: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const out: string[] = [];
  wb.eachSheet((ws) => {
    out.push(`## Hoja: ${ws.name}`);
    ws.eachRow((row) => {
      const vals = (row.values as any[]).slice(1).map((v) => cellToString(v));
      out.push(vals.join(' | '));
    });
  });
  return out.join('\n');
}

export function cellToString(v: any): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('text' in v) return String(v.text);
    if ('result' in v) return String(v.result);
    if ('richText' in v) return (v.richText as any[]).map((r) => r.text).join('');
    if ('hyperlink' in v) return String(v.hyperlink);
  }
  return String(v);
}

export async function extractText(buf: Buffer, filename: string, mimeIn?: string): Promise<Extracted> {
  const mime = guessMime(filename, mimeIn);
  if (mime === 'application/pdf') {
    let text = '';
    try {
      const r = await pdfParse(buf);
      text = r.text || '';
    } catch (e) {
      logger.warn('pdf-parse falló, se usará Claude', { error: e });
    }
    // PDF escaneado o con poco texto: Claude lo lee (hasta ~32MB / 100 páginas)
    if (text.replace(/\s/g, '').length < 300 && buf.length < 30 * 1024 * 1024) {
      return { text: await claudeReadPdf(buf), method: 'claude-pdf' };
    }
    return { text, method: 'pdf-parse' };
  }
  if (mime.includes('wordprocessingml')) {
    const r = await mammoth.extractRawText({ buffer: buf });
    return { text: r.value, method: 'mammoth' };
  }
  if (mime.includes('spreadsheetml')) return { text: await xlsxToText(buf), method: 'exceljs' };
  if (mime === 'text/html') {
    const r = htmlToText(buf.toString('utf8'));
    return { text: r.text, title: r.title, method: 'html' };
  }
  if (IMAGE_TYPES.includes(mime)) {
    const r = await claudeDescribeImage(buf, mime, 'knowledge');
    return { text: r.description, method: 'claude-vision' };
  }
  if (mime.startsWith('text/') || mime === 'application/json') return { text: buf.toString('utf8'), method: 'utf8' };
  throw new Error(`Tipo de archivo no soportado: ${mime}`);
}
