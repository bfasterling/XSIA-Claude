import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { get, post } from '../../lib/api';
import { fmtDate, fmtNum, fmtUsd } from '../../lib/format';
import { Field, Loading, Modal, Select, Stat, useAction, useAsync } from '../../components/ui';

function useFilters() {
  const [f, setF] = useState({ from: '', to: '', origin: '', siteKey: '', campaignId: '', channel: '' });
  return { f, setF, qs: new URLSearchParams(Object.entries(f).filter(([, v]) => v) as any).toString() };
}

export function Transcript({ messages }: { messages: any[] }) {
  return (
    <div className="transcript">
      {messages.map((m) => (
        <div key={m.id}>
          <div className={`msg ${m.role}`}>
            {m.role === 'assistant' ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text || ''}</ReactMarkdown> : m.text}
            {m.media?.length > 0 && <div className="small">📎 {m.media.map((x: any) => x.name).join(', ')}</div>}
            {m.ctas?.length > 0 && <div className="small muted">Opciones: {m.ctas.join(' · ')}</div>}
          </div>
          <div className="small muted" style={{ textAlign: m.role === 'user' ? 'right' : 'left', margin: '-4px 4px 8px' }}>
            {m.kind === 'outbound' ? 'mensaje automático · ' : ''}{fmtDate(m.createdAt)}
          </div>
        </div>
      ))}
      {!messages.length && <div className="muted">Sin mensajes.</div>}
    </div>
  );
}

export function SessionsTab({ agentId }: { agentId: string }) {
  const { f, setF, qs } = useFilters();
  const campaigns = useAsync(() => get('/campaigns').then((r: any) => r.items), []);
  const sites = useAsync(() => get<any[]>(`/agents/${agentId}/sites`), [agentId]);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const cursor = cursorStack[cursorStack.length - 1] || '';
  const { data, loading } = useAsync(() => get(`/agents/${agentId}/sessions?${qs}${cursor ? `&cursor=${cursor}` : ''}`), [agentId, qs, cursor]);
  const [open, setOpen] = useState<any>(null);
  const { run } = useAction();

  const upd = (k: string, v: string) => {
    setCursorStack([]);
    setF({ ...f, [k]: v });
  };
  return (
    <>
      <div className="card">
        <div className="grid3" style={{ gridTemplateColumns: 'repeat(6, minmax(0,1fr))' }}>
          <Field label="Desde"><input type="date" value={f.from} onChange={(e) => upd('from', e.target.value)} /></Field>
          <Field label="Hasta"><input type="date" value={f.to} onChange={(e) => upd('to', e.target.value)} /></Field>
          <Field label="Origen"><Select value={f.origin} onChange={(v) => upd('origin', v)} options={[['', 'Todos'], ['standard', 'Chat estándar'], ['recovery', 'Recovery']]} /></Field>
          <Field label="Campaña"><Select value={f.campaignId} onChange={(v) => upd('campaignId', v)} options={[['', 'Todas'], ...((campaigns.data || []).map((c: any) => [c.id, c.name]) as any)]} /></Field>
          <Field label="Distribuidor/sitio"><Select value={f.siteKey} onChange={(v) => upd('siteKey', v)} options={[['', 'Todos'], ...((sites.data || []).map((s: any) => [s.key, s.name]) as any)]} /></Field>
          <Field label="Canal"><Select value={f.channel} onChange={(v) => upd('channel', v)} options={[['', 'Todos'], ['web', 'Web'], ['whatsapp', 'WhatsApp'], ['voice', 'Voz']]} /></Field>
        </div>
        <div className="small muted">Combinar fecha con otros filtros puede requerir un índice compuesto en Firestore (ver docs/DESPLIEGUE_GCP.md).</div>
      </div>
      {loading ? <Loading /> : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Inicio</th><th>Origen</th><th>Canal</th><th>Sitio / campaña</th><th>Contacto</th><th>Mensajes</th><th>Tokens</th><th>Costo est.</th><th>Lead</th></tr></thead>
            <tbody>
              {(data?.items || []).map((s: any) => (
                <tr key={s.id} className="click" onClick={() => run(async () => setOpen(await get(`/sessions/${s.id}`)))}>
                  <td className="small">{fmtDate(s.startedAt)}</td>
                  <td>{s.origin === 'recovery' ? <span className="badge warn">Recovery</span> : <span className="badge info">Estándar</span>}</td>
                  <td>{s.channel}</td>
                  <td className="small">{s.siteKey || (campaigns.data || []).find((c: any) => c.id === s.campaignId)?.name || '—'}</td>
                  <td className="small">{[s.contact?.name, s.contact?.phone || s.userPhone, s.contact?.email].filter(Boolean).join(' · ') || '—'}</td>
                  <td>{s.messageCount || 0}</td>
                  <td className="small">{fmtNum((s.usage?.input || 0) + (s.usage?.output || 0) + (s.usage?.cacheRead || 0))}</td>
                  <td className="small">{fmtUsd(s.costUsd)}</td>
                  <td>{s.leadCaptured ? <span className="badge ok">Sí</span> : ''}</td>
                </tr>
              ))}
              {!data?.items?.length && <tr><td colSpan={9} className="empty">Sin sesiones para los filtros.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <div className="row end" style={{ marginTop: 10 }}>
        <button className="btn sm" disabled={!cursorStack.length} onClick={() => setCursorStack(cursorStack.slice(0, -1))}>← Anterior</button>
        <button className="btn sm" disabled={!data?.nextCursor} onClick={() => setCursorStack([...cursorStack, data.nextCursor])}>Siguiente →</button>
      </div>
      {open && (
        <Modal title={`Sesión ${open.session.id}`} onClose={() => setOpen(null)} wide>
          <div className="grid2">
            <Transcript messages={open.messages} />
            <div>
              <h3>Datos</h3>
              <pre>{JSON.stringify({ origen: open.session.origin, canal: open.session.channel, sitio: open.session.siteKey, campaña: open.session.campaignId, contacto: open.session.contact, flujos: open.session.flowRuns, uso: open.session.usage, costoUsd: open.session.costUsd }, null, 2)}</pre>
              <h3>Acciones y transferencias</h3>
              {open.actions.length ? open.actions.map((a: any) => (
                <div className="list-item small" key={a.id}>
                  <b>{a.kind}</b> · etapa <span className={`badge ${a.stage === 'accepted' ? 'ok' : a.stage === 'rejected' ? 'err' : 'warn'}`}>{a.stage}</span> {a.httpStatus && `· HTTP ${a.httpStatus}`} {a.externalId && `· ID ${a.externalId}`}
                  {a.error && <div style={{ color: 'var(--danger)' }}>{a.error}</div>}
                </div>
              )) : <div className="muted small">Sin acciones ejecutadas.</div>}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

export function DashboardTab({ agentId }: { agentId: string }) {
  const [range, setRange] = useState({ from: '', to: '' });
  const qs = new URLSearchParams(Object.entries(range).filter(([, v]) => v) as any).toString();
  const { data, loading, reload } = useAsync(() => get(`/agents/${agentId}/dashboard?${qs}`), [agentId, qs]);
  const campaigns = useAsync(() => get('/campaigns').then((r: any) => r.items), []);
  const { busy, run } = useAction();
  if (loading || !data) return <Loading />;
  const T = data.totals;
  const maxS = Math.max(1, ...data.days.map((d: any) => d.sessions || 0));
  const group = (title: string, obj: any, label: (k: string) => string = (k) => k) => (
    <div className="card">
      <h3>{title}</h3>
      <table className="tbl">
        <thead><tr><th></th><th>Sesiones</th><th>Interacciones</th><th>Tokens</th><th>Costo est.</th><th>Leads</th></tr></thead>
        <tbody>
          {Object.entries<any>(obj).map(([k, v]) => (
            <tr key={k}><td>{label(k)}</td><td>{fmtNum(v.sessions)}</td><td>{fmtNum(v.interactions)}</td><td>{fmtNum(v.tokens)}</td><td>{fmtUsd(v.costUsd)}</td><td>{fmtNum(v.leads)}</td></tr>
          ))}
          {!Object.keys(obj).length && <tr><td colSpan={6} className="muted">Sin datos</td></tr>}
        </tbody>
      </table>
    </div>
  );
  return (
    <>
      <div className="card row">
        <Field label="Desde"><input type="date" value={range.from || data.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="Hasta"><input type="date" value={range.to || data.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
        <div className="spacer" />
        <button className="btn" disabled={busy} onClick={() => run(() => post(`/agents/${agentId}/sync-recovery`).then(reload), 'Datos de Recovery sincronizados')}>Sincronizar datos de Recovery</button>
        <button className="btn no-print" onClick={() => window.print()}>Imprimir / PDF</button>
      </div>
      <div className="grid4" style={{ marginBottom: 16, gridTemplateColumns: 'repeat(5, minmax(0,1fr))' }}>
        <Stat label="Sesiones" value={fmtNum(T.sessions)} />
        <Stat label="Interacciones" value={fmtNum(T.interactions)} />
        <Stat label="Consumo (tokens)" value={fmtNum(T.tokens)} />
        <Stat label="Costo estimado" value={fmtUsd(T.costUsd)} sub="Estimación; no usar como base contable" />
        <Stat label="Leads registrados" value={fmtNum(T.leads)} />
      </div>
      <div className="card">
        <h3>Sesiones por día</h3>
        {data.days.map((d: any) => (
          <div className="row" key={d.date} style={{ gap: 8, marginBottom: 4 }}>
            <span className="small mono" style={{ width: 90 }}>{d.date}</span>
            <div className="bar" style={{ flex: 1 }}><span style={{ width: `${((d.sessions || 0) / maxS) * 100}%` }} /></div>
            <span className="small" style={{ width: 60, textAlign: 'right' }}>{d.sessions || 0}</span>
          </div>
        ))}
        {!data.days.length && <div className="muted">Sin actividad en el periodo.</div>}
      </div>
      <div className="grid2">
        {group('Por origen', T.byOrigin, (k) => (k === 'recovery' ? 'Recovery' : 'Chat estándar'))}
        {group('Por canal', T.byChannel)}
        {group('Por distribuidor / sitio', T.bySite)}
        {group('Por campaña de Recovery', T.byCampaign, (k) => (campaigns.data || []).find((c: any) => c.id === k)?.name || k)}
      </div>
    </>
  );
}
