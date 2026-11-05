import { auth } from './firebase';

export const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: any) {
    super(message);
  }
}

async function token() {
  const u = auth.currentUser;
  return u ? u.getIdToken() : null;
}

/** Llamada autenticada a la API de administración */
export async function api<T = any>(path: string, opts: { method?: string; body?: any; form?: FormData; raw?: boolean } = {}): Promise<T> {
  const t = await token();
  const res = await fetch(`${API_BASE}/api/admin${path}`, {
    method: opts.method || (opts.body || opts.form ? 'POST' : 'GET'),
    headers: {
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.form ? opts.form : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (opts.raw) {
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
    return res as any;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error || `HTTP ${res.status}`, data?.details);
  return data as T;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body: any = {}) => api<T>(p, { method: 'POST', body });
export const patch = <T = any>(p: string, body: any) => api<T>(p, { method: 'PATCH', body });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });
export const upload = <T = any>(p: string, file: File, fields: Record<string, string> = {}) => {
  const fd = new FormData();
  // Los campos deben ir antes del archivo para que el servidor los lea
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', file);
  return api<T>(p, { method: 'POST', form: fd });
};

/** Descarga un archivo autenticado (exportaciones) */
export async function download(path: string, filename: string) {
  const res: Response = await api(path, { raw: true });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* -------- API pública del chat -------- */
export async function publicGet<T = any>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}/api/public${path}`);
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data?.error || 'Error');
  return data;
}
export async function publicPost<T = any>(path: string, body: any): Promise<T> {
  const res = await fetch(`${API_BASE}/api/public${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data?.error || 'Error');
  return data;
}

/** Envía un mensaje y consume los eventos SSE de la respuesta */
export async function streamMessage(sessionId: string, text: string, channel: 'web' | 'voice', onEvent: (e: any) => void, signal?: AbortSignal) {
  const res = await fetch(`${API_BASE}/api/public/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, channel }),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = 'No se pudo enviar el mensaje';
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* */
    }
    throw new ApiError(res.status, msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) {
        try {
          onEvent(JSON.parse(line.slice(6)));
        } catch {
          /* */
        }
      }
    }
  }
}
