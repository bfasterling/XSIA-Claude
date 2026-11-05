import { useState } from 'react';
import { del, get, patch, post } from '../../lib/api';
import { API_BASE } from '../../lib/api';
import { Area, Check, Field, KeyValue, Loading, Modal, Num, Select, Text, useAction, useAsync } from '../../components/ui';

export function DistributionTab({ agent, set }: { agent: any; set: (p: string, v: any) => void }) {
  const D = agent.distribution;
  const origin = window.location.origin;
  const link = `${origin}/c/${agent.slug}`;
  const [siteKey, setSiteKey] = useState('');
  const snippet = `<script src="${origin}/widget.js"
  data-agent="${agent.slug}"${siteKey ? `\n  data-site="${siteKey}"` : ''}
  data-position="${D.widget.position}"
  data-size="${D.widget.size}"
  data-color="${D.widget.color}"
  data-icon="${D.widget.icon}"
  data-label="${D.widget.label}"${API_BASE ? '' : ''}
  defer></script>`;

  return (
    <>
      <div className="card">
        <h2>Acceso directo al chat</h2>
        <div className="row" style={{ marginBottom: 12 }}>
          <code style={{ background: 'var(--surface-2)', padding: '6px 10px', borderRadius: 8 }}>{link}</code>
          <button className="btn sm" onClick={() => navigator.clipboard.writeText(link)}>Copiar</button>
          <a className="btn sm" href={link} target="_blank" rel="noreferrer">Abrir</a>
        </div>
        <div className="grid3">
          <Field label="Publicación"><Check checked={D.published} onChange={(v) => set('distribution.published', v)} label="Chat publicado" /></Field>
          <Field label="Redirección si no está publicado"><Text value={D.redirectUrl} onChange={(v) => set('distribution.redirectUrl', v)} placeholder="https://www.marca.com" /></Field>
          <Field label="Título visible en el chat"><Text value={D.theme.title} onChange={(v) => set('distribution.theme.title', v)} placeholder={agent.name} /></Field>
        </div>
        <div className="grid3">
          <Field label="Color principal"><input type="color" value={D.theme.primaryColor} onChange={(e) => set('distribution.theme.primaryColor', e.target.value)} /></Field>
          <Field label="Logo / avatar (URL)"><Text value={D.theme.logoUrl} onChange={(v) => set('distribution.theme.logoUrl', v)} /></Field>
          <Field label="Opciones iniciales (CTA, separadas por coma)"><Text value={(D.starterCtas || []).join(', ')} onChange={(v) => set('distribution.starterCtas', v.split(',').map((s) => s.trim()).filter(Boolean))} /></Field>
        </div>
      </div>

      <div className="card">
        <h2>Widget para sitios web</h2>
        <p className="hint">Pega este fragmento antes de &lt;/body&gt; en el sitio. Prueba en escritorio y móvil.</p>
        <div className="grid4">
          <Field label="Posición"><Select value={D.widget.position} onChange={(v) => set('distribution.widget.position', v)} options={[['bottom-right', 'Inferior derecha'], ['bottom-left', 'Inferior izquierda'], ['top-right', 'Superior derecha'], ['top-left', 'Superior izquierda']]} /></Field>
          <Field label="Tamaño"><Select value={D.widget.size} onChange={(v) => set('distribution.widget.size', v)} options={[['sm', 'Chico'], ['md', 'Mediano'], ['lg', 'Grande']]} /></Field>
          <Field label="Icono"><Select value={D.widget.icon} onChange={(v) => set('distribution.widget.icon', v)} options={[['chat', 'Burbuja'], ['car', 'Auto'], ['help', 'Ayuda'], ['spark', 'Destello']]} /></Field>
          <Field label="Color"><input type="color" value={D.widget.color} onChange={(e) => set('distribution.widget.color', e.target.value)} /></Field>
        </div>
        <div className="grid2">
          <Field label="Etiqueta del botón"><Text value={D.widget.label} onChange={(v) => set('distribution.widget.label', v)} /></Field>
          <Field label="Sitio / distribuidor (opcional)" help="Clave del sitio para asociar las conversaciones"><Text value={siteKey} onChange={setSiteKey} /></Field>
        </div>
        <pre>{snippet}</pre>
        <button className="btn sm" onClick={() => navigator.clipboard.writeText(snippet)}>Copiar fragmento</button>
      </div>

      <SitesCard agentId={agent.id} slug={agent.slug} />
    </>
  );
}

function SitesCard({ agentId, slug }: { agentId: string; slug: string }) {
  const { data, loading, reload } = useAsync(() => get<any[]>(`/agents/${agentId}/sites`), [agentId]);
  const { busy, run } = useAction();
  const [edit, setEdit] = useState<any>(null);
  return (
    <div className="card">
      <div className="row between">
        <div>
          <h2>Distribuidores / sitios (multisitio)</h2>
          <p className="hint">Un mismo agente con identidad común y parámetros por sucursal. Enlace: /c/{slug}?site=CLAVE</p>
        </div>
        <button className="btn" onClick={() => setEdit({ key: '', name: '', dealerCode: '', instructions: '', enabled: true })}>+ Agregar sitio</button>
      </div>
      {loading ? <Loading /> : (
        <table className="tbl">
          <thead><tr><th>Clave</th><th>Nombre</th><th>Código distribuidor</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            {(data || []).map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.key}</td><td>{s.name}</td><td>{s.dealerCode || '—'}</td>
                <td>{s.enabled ? <span className="badge ok">Habilitado</span> : <span className="badge">Deshabilitado</span>}</td>
                <td className="row" style={{ gap: 6 }}>
                  <a className="btn sm" href={`/c/${slug}?site=${s.key}`} target="_blank" rel="noreferrer">Probar</a>
                  <button className="btn sm" onClick={() => setEdit(s)}>Editar</button>
                  <button className="btn sm danger" onClick={() => confirm('¿Eliminar sitio?') && run(() => del(`/agents/${agentId}/sites/${s.id}`).then(reload))}>Eliminar</button>
                </td>
              </tr>
            ))}
            {!data?.length && <tr><td colSpan={5} className="empty">Sin sitios configurados.</td></tr>}
          </tbody>
        </table>
      )}
      {edit && (
        <Modal title={edit.id ? 'Editar sitio' : 'Nuevo sitio'} onClose={() => setEdit(null)}>
          <div className="grid2">
            <Field label="Clave"><Text value={edit.key} disabled={!!edit.id} onChange={(v) => setEdit({ ...edit, key: v })} /></Field>
            <Field label="Nombre comercial"><Text value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} /></Field>
          </div>
          <Field label="Código de distribuidor"><Text value={edit.dealerCode} onChange={(v) => setEdit({ ...edit, dealerCode: v })} /></Field>
          <Field label="Indicaciones específicas del negocio"><Area value={edit.instructions} onChange={(v) => setEdit({ ...edit, instructions: v })} placeholder="Horario, dirección, promociones locales, asesores…" /></Field>
          <Check checked={edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} label="Habilitado" />
          <div className="row end">
            <button className="btn primary" disabled={busy} onClick={() => run(() => (edit.id ? patch(`/agents/${agentId}/sites/${edit.id}`, edit) : post(`/agents/${agentId}/sites`, edit)).then(() => { setEdit(null); reload(); }), 'Sitio guardado')}>Guardar</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function ChannelsTab({ agent, set }: { agent: any; set: (p: string, v: any) => void }) {
  const lines = useAsync(() => get<any[]>('/lines'), []);
  const voices = useAsync(() => get<any[]>(`/voices?lang=${(agent.voice.languageCode || 'es').slice(0, 2)}`).catch(() => []), [agent.voice.languageCode]);
  const W = agent.whatsapp;
  const V = agent.voice;
  const CM = agent.chatManager;
  const DL = agent.dealers;
  return (
    <>
      <div className="card">
        <h2>WhatsApp</h2>
        <p className="hint">Líneas por las que este agente atiende conversaciones iniciadas por clientes. Las líneas se registran en “Líneas WhatsApp”. Una línea solo opera si está conectada y autorizada en Meta.</p>
        <Check checked={W.enabled} onChange={(v) => set('whatsapp.enabled', v)} label="Habilitar canal WhatsApp" />
        <div style={{ marginTop: 10 }}>
          {lines.loading ? <Loading /> : (lines.data || []).map((l) => (
            <div key={l.id} style={{ marginBottom: 6 }}>
              <Check
                checked={W.lineIds.includes(l.id)}
                onChange={(c) => set('whatsapp.lineIds', c ? [...W.lineIds, l.id] : W.lineIds.filter((x: string) => x !== l.id))}
                label={<span>{l.name} <span className="muted small">({l.displayPhone || l.phoneNumberId})</span> {!l.enabled && <span className="badge err">deshabilitada</span>}</span>}
              />
            </div>
          ))}
          {!lines.loading && !lines.data?.length && <div className="muted">No hay líneas registradas.</div>}
        </div>
      </div>

      <div className="card">
        <h2>Voz</h2>
        <p className="hint">Interacción oral en el chat web. “Estable” espera la respuesta completa; “Inmediata” habla por frases conforme se genera. El micrófono se pausa mientras el agente habla para no escucharse a sí mismo.</p>
        <Check checked={V.enabled} onChange={(v) => set('voice.enabled', v)} label="Habilitar voz" />
        <div className="grid4" style={{ marginTop: 10 }}>
          <Field label="Modo"><Select value={V.mode} onChange={(v) => set('voice.mode', v)} options={[['stable', 'Estable'], ['realtime', 'Inmediata']]} /></Field>
          <Field label="Idioma"><Select value={V.languageCode} onChange={(v) => set('voice.languageCode', v)} options={[['es-US', 'Español (EE. UU./LatAm)'], ['es-ES', 'Español (España)'], ['en-US', 'Inglés (EE. UU.)']]} /></Field>
          <Field label="Voz (Google Cloud TTS)">
            {voices.data?.length ? (
              <Select value={V.voiceName} onChange={(v) => set('voice.voiceName', v)} options={voices.data.filter((x: any) => x.languageCodes.includes(V.languageCode)).map((x: any) => [x.name, `${x.name} (${x.gender})`]) as any} />
            ) : (
              <Text value={V.voiceName} onChange={(v) => set('voice.voiceName', v)} />
            )}
          </Field>
          <Field label="Velocidad"><Num step="0.05" value={V.speakingRate} onChange={(v) => set('voice.speakingRate', v)} /></Field>
        </div>
        <div className="grid2">
          <Field label="Silencio para fin de turno (ms)"><Num value={V.silenceMs} onChange={(v) => set('voice.silenceMs', v)} /></Field>
          <Field label="Sensibilidad (0–1)"><Num step="0.1" value={V.sensitivity} onChange={(v) => set('voice.sensitivity', v)} /></Field>
        </div>
      </div>

      <div className="card">
        <h2>Directorio de distribuidores</h2>
        <p className="hint">Permite que el agente ofrezca distribuidores cercanos a la ubicación indicada por el cliente.</p>
        <div className="grid3">
          <Field label="Fuente"><Select value={DL.mode} onChange={(v) => set('dealers.mode', v)} options={[['none', 'Deshabilitado'], ['internal', 'Directorio interno (Distribuidores)'], ['external', 'Servicio externo']]} /></Field>
          <Field label="Filtro de marca"><Text value={DL.brandFilter} onChange={(v) => set('dealers.brandFilter', v)} /></Field>
          <Field label="Opciones a mostrar"><Num value={DL.defaultCount} onChange={(v) => set('dealers.defaultCount', v)} /></Field>
        </div>
        {DL.mode === 'external' && (
          <>
            <div className="grid2">
              <Field label="URL" help="Admite {{postalCode}}, {{city}}, {{state}}, {{brand}}, {{count}}"><Text value={DL.externalUrl} onChange={(v) => set('dealers.externalUrl', v)} /></Field>
              <Field label="Método"><Select value={DL.externalMethod} onChange={(v) => set('dealers.externalMethod', v)} options={['GET', 'POST']} /></Field>
            </div>
            <Field label="Encabezados"><KeyValue value={DL.headers} onChange={(v) => set('dealers.headers', v)} /></Field>
          </>
        )}
      </div>

      <div className="card">
        <h2>Atención humana (Chat Manager)</h2>
        <p className="hint">Conexión con el sistema de atención humana para transferir conversaciones que lo ameriten.</p>
        <Check checked={CM.enabled} onChange={(v) => set('chatManager.enabled', v)} label="Habilitar transferencia a asesor" />
        <div className="grid2" style={{ marginTop: 10 }}>
          <Field label="Webhook del Chat Manager"><Text value={CM.webhookUrl} onChange={(v) => set('chatManager.webhookUrl', v)} /></Field>
          <Field label="Criterios de transferencia"><Text value={CM.instructions} onChange={(v) => set('chatManager.instructions', v)} placeholder="Cuando el cliente lo pida o tenga una queja" /></Field>
        </div>
        <Field label="Encabezados"><KeyValue value={CM.headers} onChange={(v) => set('chatManager.headers', v)} /></Field>
      </div>
    </>
  );
}
