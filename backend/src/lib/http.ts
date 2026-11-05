export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public details?: any) {
    super(message);
  }
}
export const badRequest = (m: string, d?: any) => new HttpError(400, m, d);
export const notFound = (m = 'No encontrado') => new HttpError(404, m);
export const forbidden = (m = 'Sin permisos') => new HttpError(403, m);
export const conflict = (m: string, d?: any) => new HttpError(409, m, d);

/** fetch con timeout */
export async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 15000);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function readBody(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
