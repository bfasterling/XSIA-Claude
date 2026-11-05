import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, publicPost } from '../../lib/api';

export interface VoiceConfig {
  enabled: boolean;
  mode: 'stable' | 'realtime';
  languageCode: string;
  silenceMs: number;
  sensitivity: number;
  serverTts: boolean;
}

type Status = 'off' | 'listening' | 'thinking' | 'speaking';

/** Limpia texto para síntesis de voz */
function speakable(t: string) {
  return t
    .replace(/<ctas>[\s\S]*?(<\/ctas>|$)/gi, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#>`|]/g, '')
    .trim();
}

/**
 * Voz en el navegador:
 *  - Reconocimiento: Web Speech API (Chrome/Edge/Safari) o grabación + Speech-to-Text del servidor.
 *  - Síntesis: Google Cloud TTS (servidor) o speechSynthesis del navegador.
 *  - Protección de eco: el micrófono se detiene mientras el agente habla.
 */
export function useVoice(slug: string, cfg: VoiceConfig | null, onUtterance: (text: string) => void) {
  const [status, setStatus] = useState<Status>('off');
  const [interim, setInterim] = useState('');
  const activeRef = useRef(false);
  const recRef = useRef<any>(null);
  const silenceTimer = useRef<any>(null);
  const finalText = useRef('');
  const queue = useRef<string[]>([]);
  const playing = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingSentence = useRef('');
  const mediaRef = useRef<{ stream?: MediaStream; recorder?: MediaRecorder; ctx?: AudioContext; raf?: number } | null>(null);
  const SR: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;

  const stopListening = useCallback(() => {
    clearTimeout(silenceTimer.current);
    try {
      recRef.current?.stop();
    } catch {
      /* */
    }
    recRef.current = null;
    const m = mediaRef.current;
    if (m) {
      if (m.raf) cancelAnimationFrame(m.raf);
      if (m.recorder?.state === 'recording') m.recorder.stop();
      m.stream?.getTracks().forEach((t) => t.stop());
      m.ctx?.close().catch(() => undefined);
      mediaRef.current = null;
    }
  }, []);

  const submit = useCallback(
    (text: string) => {
      const t = text.trim();
      finalText.current = '';
      setInterim('');
      if (!t) return;
      stopListening();
      setStatus('thinking');
      onUtterance(t);
    },
    [onUtterance, stopListening],
  );

  /** Respaldo: grabación con detección de silencio y transcripción en servidor */
  const startRecorderFallback = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = async () => {
      if (!activeRef.current || !chunks.length) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      setStatus('thinking');
      const fd = new FormData();
      fd.append('file', blob, 'voz.webm');
      try {
        const r = await fetch(`${API_BASE}/api/public/voice/stt?lang=${cfg?.languageCode || 'es-MX'}`, { method: 'POST', body: fd });
        const j = await r.json();
        if (j.text) submit(j.text);
        else listen();
      } catch {
        listen();
      }
    };
    mediaRef.current = { stream, recorder, ctx };
    recorder.start();
    const threshold = 0.02 + (1 - (cfg?.sensitivity ?? 0.5)) * 0.06;
    let spoke = false;
    let lastVoice = Date.now();
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / data.length);
      if (rms > threshold) {
        spoke = true;
        lastVoice = Date.now();
      }
      if (spoke && Date.now() - lastVoice > (cfg?.silenceMs || 1200)) {
        recorder.stop();
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (mediaRef.current) mediaRef.current.raf = requestAnimationFrame(loop);
    };
    loop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, submit]);

  const listen = useCallback(() => {
    if (!activeRef.current || !cfg) return;
    setStatus('listening');
    finalText.current = '';
    if (!SR) {
      startRecorderFallback().catch(() => setStatus('off'));
      return;
    }
    const rec = new SR();
    rec.lang = cfg.languageCode;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev: any) => {
      let interimT = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const conf = r[0].confidence;
        if (r.isFinal) {
          if (!conf || conf >= cfg.sensitivity * 0.5) finalText.current += ' ' + r[0].transcript;
        } else interimT += r[0].transcript;
      }
      setInterim((finalText.current + ' ' + interimT).trim());
      clearTimeout(silenceTimer.current);
      silenceTimer.current = setTimeout(() => submit(finalText.current || interimT), cfg.silenceMs || 1200);
    };
    rec.onerror = (e: any) => {
      if (e.error === 'not-allowed') {
        activeRef.current = false;
        setStatus('off');
      }
    };
    rec.onend = () => {
      // Chrome detiene el reconocimiento tras silencios largos: reanudar si seguimos escuchando
      if (activeRef.current && recRef.current === rec) {
        try {
          rec.start();
        } catch {
          /* */
        }
      }
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      /* */
    }
  }, [cfg, SR, submit, startRecorderFallback]);

  const playNext = useCallback(async () => {
    if (playing.current) return;
    const next = queue.current.shift();
    if (!next) return;
    playing.current = true;
    stopListening(); // protección de eco
    setStatus('speaking');
    const done = () => {
      playing.current = false;
      if (queue.current.length) playNext();
      else if (activeRef.current) listen();
      else setStatus('off');
    };
    try {
      if (cfg?.serverTts) {
        const r = await publicPost<{ audio: string }>('/voice/tts', { slug, text: next });
        const a = new Audio(`data:audio/mpeg;base64,${r.audio}`);
        audioRef.current = a;
        a.onended = done;
        a.onerror = done;
        await a.play();
      } else throw new Error('browser');
    } catch {
      const u = new SpeechSynthesisUtterance(next);
      u.lang = cfg?.languageCode || 'es-US';
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    }
  }, [cfg, slug, listen, stopListening]);

  const speak = useCallback(
    (text: string) => {
      const t = speakable(text);
      if (!t) {
        if (activeRef.current) listen();
        return;
      }
      queue.current.push(t);
      playNext();
    },
    [playNext, listen],
  );

  /** Modo inmediato: recibe deltas y habla por oraciones */
  const onDelta = useCallback(
    (delta: string) => {
      if (!activeRef.current || cfg?.mode !== 'realtime') return;
      pendingSentence.current += delta;
      const m = pendingSentence.current.match(/^([\s\S]*?[.!?…:])\s+/);
      if (m && m[1].length > 25 && !m[1].includes('<ctas')) {
        pendingSentence.current = pendingSentence.current.slice(m[0].length);
        speak(m[1]);
      }
    },
    [cfg, speak],
  );

  /** Fin de respuesta: en modo estable habla todo; en inmediato, el remanente */
  const onDone = useCallback(
    (fullText: string) => {
      if (!activeRef.current) return;
      if (cfg?.mode === 'realtime') {
        const rest = pendingSentence.current;
        pendingSentence.current = '';
        if (speakable(rest)) speak(rest);
        else if (!playing.current && !queue.current.length) listen();
      } else speak(fullText);
    },
    [cfg, speak, listen],
  );

  const start = useCallback(() => {
    activeRef.current = true;
    listen();
  }, [listen]);
  const stop = useCallback(() => {
    activeRef.current = false;
    queue.current = [];
    pendingSentence.current = '';
    stopListening();
    audioRef.current?.pause();
    speechSynthesis?.cancel();
    playing.current = false;
    setStatus('off');
    setInterim('');
  }, [stopListening]);

  useEffect(() => () => stop(), [stop]);

  return { status, interim, active: status !== 'off', start, stop, onDelta, onDone, supported: !!SR || !!navigator.mediaDevices?.getUserMedia };
}
