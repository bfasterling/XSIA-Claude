import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { publicGet, publicPost, streamMessage } from '../../lib/api';
import { useVoice } from './useVoice';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ctas?: string[];
  media?: Array<{ id: string; url: string; name: string; mimeType?: string }>;
  pending?: boolean;
  error?: boolean;
}

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {
      /* almacenamiento no disponible */
    }
  },
};

/** Oculta la línea de CTA mientras se recibe la respuesta */
const visible = (t: string) => t.replace(/<ctas>[\s\S]*$/i, '').replace(/<cta[^>]*$/i, '').trimEnd();

export default function ChatPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  const site = params.get('site') || '';
  const embed = params.get('embed') === '1';
  const [cfg, setCfg] = useState<any>(null);
  const [error, setError] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState('');
  const [lightbox, setLightbox] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const key = `xsia:${slug}:${site}`;

  // Voz
  const sendRef = useRef<(t: string, v?: boolean) => void>(() => undefined);
  const voice = useVoice(slug, cfg?.voice?.enabled ? cfg.voice : null, (t) => sendRef.current(t, true));

  const newSession = useCallback(async () => {
    const r = await publicPost<{ sessionId: string }>(`/agents/${slug}/sessions`, { siteKey: site, referrer: document.referrer });
    store.set(key, r.sessionId);
    setSessionId(r.sessionId);
    const h = await publicGet<{ messages: any[] }>(`/sessions/${r.sessionId}/messages`);
    setMsgs(h.messages.map((m) => ({ id: m.id, role: m.role, text: m.text || '', ctas: m.ctas, media: m.media })));
  }, [slug, site, key]);

  useEffect(() => {
    (async () => {
      try {
        const c = await publicGet(`/agents/${slug}${site ? `?site=${encodeURIComponent(site)}` : ''}`);
        if (c.redirectUrl) {
          window.location.href = c.redirectUrl;
          return;
        }
        setCfg(c);
        document.title = c.theme?.title || c.name;
        const saved = store.get(key);
        if (saved) {
          try {
            const h = await publicGet<{ messages: any[] }>(`/sessions/${saved}/messages`);
            setSessionId(saved);
            setMsgs(h.messages.map((m) => ({ id: m.id, role: m.role, text: m.text || '', ctas: m.ctas, media: m.media })));
            return;
          } catch {
            store.set(key, null);
          }
        }
        await newSession();
      } catch (e: any) {
        setError(e?.message || 'Chat no disponible');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, site]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, tool]);

  const send = useCallback(
    async (text: string, viaVoice = false) => {
      const t = text.trim();
      if (!t || !sessionId || busy) return;
      setInput('');
      setBusy(true);
      const aid = `a${Date.now()}`;
      // Las opciones previas desaparecen una vez usadas
      setMsgs((m) => [...m.map((x) => ({ ...x, ctas: undefined })), { id: `u${Date.now()}`, role: 'user', text: t }, { id: aid, role: 'assistant', text: '', pending: true, media: [] }]);
      const update = (fn: (m: Msg) => Msg) => setMsgs((all) => all.map((m) => (m.id === aid ? fn(m) : m)));
      try {
        await streamMessage(sessionId, t, viaVoice ? 'voice' : 'web', (e) => {
          if (e.type === 'delta') {
            update((m) => ({ ...m, text: m.text + e.text }));
            if (viaVoice) voice.onDelta(e.text);
          } else if (e.type === 'tool') setTool(e.status === 'start' ? e.name : '');
          else if (e.type === 'media') update((m) => ({ ...m, media: [...(m.media || []), e.item] }));
          else if (e.type === 'ctas') update((m) => ({ ...m, ctas: e.ctas }));
          else if (e.type === 'done') {
            update((m) => ({ ...m, text: e.text, ctas: e.ctas, pending: false }));
            if (viaVoice) voice.onDone(e.text);
          } else if (e.type === 'error') update((m) => ({ ...m, text: e.message, error: true, pending: false }));
        });
      } catch (e: any) {
        update((m) => ({ ...m, text: e?.message || 'No fue posible enviar tu mensaje.', error: true, pending: false }));
        if (viaVoice) voice.stop();
      } finally {
        setBusy(false);
        setTool('');
        update((m) => ({ ...m, pending: false }));
      }
    },
    [sessionId, busy, voice],
  );
  sendRef.current = send;

  if (error) return <div className="empty" style={{ paddingTop: 80 }}>{error}</div>;
  if (!cfg) return <div className="empty" style={{ paddingTop: 80 }}><span className="spinner" /></div>;

  const color = cfg.theme?.primaryColor || '#1f6feb';
  const title = cfg.theme?.title || cfg.name;
  const toolLabel: Record<string, string> = {
    buscar_conocimiento: 'Consultando información…',
    consultar_base_datos: 'Consultando datos…',
    buscar_imagenes: 'Buscando imágenes…',
    mostrar_recursos: 'Preparando imágenes…',
    buscar_distribuidores: 'Buscando distribuidores…',
  };

  return (
    <div className="chat" style={{ ['--c' as any]: color }}>
      <header className="chat-head">
        <div className="avatar">{cfg.theme?.logoUrl ? <img src={cfg.theme.logoUrl} alt="" /> : title.slice(0, 1)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="title">{title}</div>
          <div className="status">{cfg.site ? cfg.site.name : busy ? 'Escribiendo…' : 'En línea'}</div>
        </div>
        <button className="btn sm ghost" title="Nueva conversación" onClick={() => { voice.stop(); newSession(); }}>Nueva</button>
        {embed && <button className="btn sm ghost" onClick={() => window.parent?.postMessage({ type: 'xsia:close' }, '*')}>✕</button>}
      </header>

      <div className="chat-body" ref={bodyRef}>
        <div className="chat-inner">
          {msgs.map((m) => (
            <MessageView key={m.id} m={m} onCta={(c) => send(c)} onZoom={setLightbox} disabled={busy} />
          ))}
          {busy && (
            <div className="typing">
              <span className="dots"><span /><span /><span /></span>
              {tool && (toolLabel[tool] || (tool.startsWith('api_') ? 'Consultando servicio…' : tool.startsWith('flujo_') || tool.startsWith('seleccionar') ? 'Registrando tu solicitud…' : ''))}
            </div>
          )}
        </div>
      </div>

      <div className="chat-input">
        {voice.active && (
          <div className="voice-bar">
            {voice.status === 'listening' && <>🎙️ Escuchando… {voice.interim && <i>“{voice.interim}”</i>}</>}
            {voice.status === 'thinking' && <>Pensando…</>}
            {voice.status === 'speaking' && <>🔊 Hablando…</>}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <textarea
            rows={1}
            value={input}
            placeholder="Escribe tu mensaje…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            disabled={voice.active}
          />
          {cfg.voice?.enabled && voice.supported && (
            <button
              type="button"
              className={`round ${voice.active ? 'live' : 'secondary'}`}
              title={voice.active ? 'Detener voz' : 'Hablar'}
              onClick={() => (voice.active ? voice.stop() : voice.start())}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5" /></svg>
            </button>
          )}
          <button className="round" disabled={busy || !input.trim()} title="Enviar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12l16-8-6 16-2-7-8-1z" /></svg>
          </button>
        </form>
      </div>
      {lightbox && <div className="lightbox" onClick={() => setLightbox(null)}><img src={lightbox} alt="" /></div>}
    </div>
  );
}

function MessageView({ m, onCta, onZoom, disabled }: { m: Msg; onCta: (c: string) => void; onZoom: (u: string) => void; disabled: boolean }) {
  const text = m.role === 'assistant' ? visible(m.text) : m.text;
  return (
    <>
      {(text || !m.pending) && (text || m.error) ? (
        <div className={`bubble ${m.role}`} style={m.error ? { borderColor: '#f1c3c0', color: '#c62828' } : undefined}>
          {m.role === 'assistant' ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }}>{text}</ReactMarkdown>
          ) : (
            text
          )}
        </div>
      ) : null}
      {!!m.media?.length && (
        <div className="media-row">
          {m.media.map((x) =>
            (x.mimeType || 'image/').startsWith('image/') ? (
              <img key={x.id} src={x.url} alt={x.name} title={x.name} onClick={() => onZoom(x.url)} />
            ) : (
              <a key={x.id} className="file" href={x.url} target="_blank" rel="noreferrer">📄 {x.name}</a>
            ),
          )}
        </div>
      )}
      {!!m.ctas?.length && !m.pending && (
        <div className="ctas">
          {m.ctas.map((c) => (
            <button key={c} onClick={() => onCta(c)} disabled={disabled}>{c}</button>
          ))}
        </div>
      )}
    </>
  );
}
