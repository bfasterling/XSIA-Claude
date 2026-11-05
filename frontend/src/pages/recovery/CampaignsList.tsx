import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { del, get, post } from '../../lib/api';
import { CAMPAIGN_STATUS_LABEL, fmtDate, fmtNum } from '../../lib/format';
import { ErrorBox, Field, Loading, Modal, Select, Stat, StatusBadge, Text, useAction, useAsync } from '../../components/ui';

export default function CampaignsList() {
  const { data, error, loading, reload } = useAsync(() => get('/campaigns'), []);
  const agents = useAsync(() => get<any[]>('/agents'), []);
  const { busy, run } = useAction();
  const nav = useNavigate();
  const [creating, setCreating] = useState<any>(null);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>XSIA Recovery</h1>
          <p>Reactivación de oportunidades no contactadas, abandonadas o rechazadas vía WhatsApp, con atención conversacional y transferencia al CRM.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating({ name: '', description: '', agentId: '' })}>+ Nueva campaña</button>
      </div>
      <ErrorBox error={error} />
      {loading || !data ? <Loading /> : (
        <>
          <div className="grid4" style={{ marginBottom: 16 }}>
            <Stat label="Campañas" value={fmtNum(data.totals.campaigns)} />
            <Stat label="En ejecución" value={fmtNum(data.totals.running)} />
            <Stat label="Leads cargados" value={fmtNum(data.totals.leads)} />
            <Stat label="Recuperados" value={fmtNum(data.totals.recovered)} />
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Campaña</th><th>Estado</th><th>Leads</th><th>Elegibles</th><th>Enviados</th><th>Respondidos</th><th>Recuperados</th><th>Creada</th><th></th></tr></thead>
              <tbody>
                {data.items.map((c: any) => (
                  <tr key={c.id}>
                    <td><Link to={`/admin/recovery/${c.id}`}><b>{c.name}</b></Link><div className="small muted">{c.description}</div>{c.status === 'running' && c.lastTickNote && <div className="small muted">⏱ {c.lastTickNote}</div>}</td>
                    <td><StatusBadge status={c.status} /> <span className="small muted">{CAMPAIGN_STATUS_LABEL[c.status]}</span></td>
                    <td>{fmtNum(c.counters.leads)}</td>
                    <td>{fmtNum(c.counters.eligible)}</td>
                    <td>{fmtNum(c.counters.sent)}</td>
                    <td>{fmtNum(c.counters.replied)}</td>
                    <td>{fmtNum(c.counters.recovered)}</td>
                    <td className="small muted">{fmtDate(c.createdAt)}</td>
                    <td>
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        <Link className="btn sm" to={`/admin/recovery/${c.id}`}>Configurar</Link>
                        <Link className="btn sm" to={`/admin/recovery/${c.id}/reports`}>Reportes</Link>
                        <button className="btn sm" disabled={busy} onClick={() => run(async () => { const r = await post(`/campaigns/${c.id}/duplicate`); nav(`/admin/recovery/${r.id}`); }, 'Campaña duplicada como borrador (sin leads ni métricas)')}>Duplicar</button>
                        <button className="btn sm danger" disabled={busy || c.status === 'running'} title={c.status === 'running' ? 'Pausa o cancela antes de eliminar' : ''} onClick={() => confirm(`¿Eliminar "${c.name}" con todos sus leads e historial?`) && run(() => del(`/campaigns/${c.id}`).then(reload), 'Campaña eliminada')}>Eliminar</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!data.items.length && <tr><td colSpan={9} className="empty">Sin campañas.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
      {creating && (
        <Modal title="Nueva campaña" onClose={() => setCreating(null)}>
          <Field label="Nombre"><Text value={creating.name} onChange={(v) => setCreating({ ...creating, name: v })} autoFocus /></Field>
          <Field label="Descripción" help="Propósito, periodo, unidad comercial o base de origen"><Text value={creating.description} onChange={(v) => setCreating({ ...creating, description: v })} /></Field>
          <Field label="Agente XSIA"><Select value={creating.agentId} onChange={(v) => setCreating({ ...creating, agentId: v })} options={[['', '— Selecciona —'], ...((agents.data || []).map((a) => [a.id, a.name]) as any)]} /></Field>
          <div className="row end">
            <button className="btn primary" disabled={!creating.name || busy} onClick={() => run(async () => { const r = await post('/campaigns', creating); nav(`/admin/recovery/${r.id}`); })}>Crear</button>
          </div>
        </Modal>
      )}
    </>
  );
}
