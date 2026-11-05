import { Storage } from '@google-cloud/storage';
import { config } from '../config.js';

export const storage = new Storage();

export function bucket(name = config.storage.bucket) {
  if (!name) throw new Error('GCS_BUCKET no configurado');
  return storage.bucket(name);
}

export async function uploadBuffer(path: string, buf: Buffer, contentType: string, bucketName?: string) {
  const file = bucket(bucketName).file(path);
  await file.save(buf, { contentType, resumable: false });
  return `gs://${file.bucket.name}/${path}`;
}

export async function downloadBuffer(gsPathOrPath: string): Promise<Buffer> {
  let b = config.storage.bucket;
  let p = gsPathOrPath;
  if (gsPathOrPath.startsWith('gs://')) {
    const rest = gsPathOrPath.slice(5);
    b = rest.split('/')[0];
    p = rest.slice(b.length + 1);
  }
  const [data] = await bucket(b).file(p).download();
  return data;
}

export async function deletePath(gsPath: string) {
  if (!gsPath?.startsWith('gs://')) return;
  const rest = gsPath.slice(5);
  const b = rest.split('/')[0];
  await bucket(b)
    .file(rest.slice(b.length + 1))
    .delete({ ignoreNotFound: true })
    .catch(() => undefined);
}

/** URL pública de un objeto del bucket de medios (bucket con lectura pública o detrás de CDN) */
export function publicUrl(path: string, bucketName = config.storage.mediaBucket) {
  return `https://storage.googleapis.com/${bucketName}/${encodeURI(path)}`;
}

/** URL firmada de lectura (si el bucket de medios no es público) */
export async function signedReadUrl(gsPath: string, minutes = 60 * 24 * 6) {
  const rest = gsPath.slice(5);
  const b = rest.split('/')[0];
  const [url] = await bucket(b)
    .file(rest.slice(b.length + 1))
    .getSignedUrl({ action: 'read', expires: Date.now() + minutes * 60 * 1000, version: 'v4' });
  return url;
}
