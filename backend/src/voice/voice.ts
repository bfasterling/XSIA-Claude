import { GoogleAuth } from 'google-auth-library';
import { fetchWithTimeout } from '../lib/http.js';
import { config } from '../config.js';

/**
 * Voz:
 *  - TTS: Google Cloud Text-to-Speech (voces Neural2/Chirp seleccionables por agente).
 *  - STT: Google Cloud Speech-to-Text (respaldo para navegadores sin Web Speech API y
 *         para notas de voz de WhatsApp).
 */
const gauth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
async function token() {
  return (await gauth.getAccessToken()) as string;
}

export function cleanForSpeech(text: string) {
  return text
    .replace(/<ctas>[\s\S]*?<\/ctas>/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'el enlace en pantalla')
    .replace(/[*_#>`|]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\n{2,}/g, '. ')
    .trim();
}

export async function synthesize(text: string, voiceName: string, languageCode: string, speakingRate = 1): Promise<string> {
  if (!config.google.ttsEnabled) throw new Error('TTS deshabilitado');
  const res = await fetchWithTimeout('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', 'x-goog-user-project': config.projectId },
    body: JSON.stringify({
      input: { text: cleanForSpeech(text).slice(0, 4800) },
      voice: { languageCode, name: voiceName },
      audioConfig: { audioEncoding: 'MP3', speakingRate },
    }),
    timeoutMs: 20000,
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return json.audioContent as string; // base64 mp3
}

export async function listVoices(languageCode = 'es') {
  const res = await fetchWithTimeout(`https://texttospeech.googleapis.com/v1/voices?languageCode=${languageCode}`, {
    headers: { Authorization: `Bearer ${await token()}`, 'x-goog-user-project': config.projectId },
  });
  const json: any = await res.json();
  return (json.voices || []).map((v: any) => ({ name: v.name, languageCodes: v.languageCodes, gender: v.ssmlGender }));
}

export async function transcribeAudio(buf: Buffer, mime: string, languageCode = 'es-MX'): Promise<string> {
  if (!config.google.sttEnabled) return '';
  const m = mime.toLowerCase();
  const encoding = m.includes('ogg') ? 'OGG_OPUS' : m.includes('webm') ? 'WEBM_OPUS' : m.includes('mpeg') || m.includes('mp3') ? 'MP3' : m.includes('wav') ? 'LINEAR16' : 'OGG_OPUS';
  const rates = encoding === 'OGG_OPUS' || encoding === 'WEBM_OPUS' ? [48000, 16000] : [undefined];
  for (const rate of rates) {
    const res = await fetchWithTimeout('https://speech.googleapis.com/v1/speech:recognize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', 'x-goog-user-project': config.projectId },
      body: JSON.stringify({
        config: {
          encoding,
          ...(rate ? { sampleRateHertz: rate } : {}),
          languageCode,
          alternativeLanguageCodes: ['es-US', 'en-US'],
          enableAutomaticPunctuation: true,
          model: 'latest_short',
        },
        audio: { content: buf.toString('base64') },
      }),
      timeoutMs: 30000,
    });
    if (!res.ok) continue;
    const json: any = await res.json();
    const text = (json.results || []).map((r: any) => r.alternatives?.[0]?.transcript || '').join(' ').trim();
    if (text) return text;
  }
  return '';
}
