import { useState } from 'react';
import { del, download, get, patch, post, upload } from '../../lib/api';
import { LEAD_STATUS_LABEL, LEAD_TYPE_LABEL, OUTCOME_LABEL, fmtDate, fmtNum, pct } from '../../lib/format';
import { Check, Field, FilePick, Loading, Modal, Select, Stat, StatusBadge, Text, useAction, useAsync } from '../../components/ui';
import { Transcript } from '../agents/DataTabs';

const TYPE_OPTS: Array<[string, string]> = [['', 'Todos'], ['NOT_CONTACTED', 'No contactado'], ['ABANDONED', 'Abandonado'], ['REJECTED', 'Rechazado']];
const STATUS_OPTS: Array<[string, string]> = [['', 'Todos'], ...Object.entries(LEAD_STATUS_LABEL)];

/* ============================== LEADS ============================== */
export function LeadsTab({ campaignId, campaign }: { campaignId: string; campaign: any }) {
  const meta = useAsync(() => get('/campaigns/meta'), []);
  const batches = useAsync(() => get<any[]>(`/campaigns/${campaignId}/imports`), [campaignId]);
  const { busy, run } = useAction();
  const [wizard, setWizard] = useState<any>(null);
  const [filters, setFilters] = useState({ search: '', eligible: '', status: '', type: '', batchId: '', limit: '25' });
  const [stack, setStack] = useState<string[]>([]);
  const cursor = stack[stack.length - 1] || '';
  const qs = new URLSearchParams(Object.entries({ ...filters, cursor }).filter(([, v]) => v) as any).toString();
  const leads = useAsync(() => get(`/campaigns/${campaignId}/leads?${qs}`), [campaignId, qs]);
  const [detail, setDetail] = useState<any>(null);

  const setF = (k: string, v: string) => {
    setStack([]);
    setFilters({ ...filters, [k]: v });
  };
  const openLead = (id: string) => run(async () => setDetail(await get(`/campaigns/${campaignId}/leads/${id}`)));
  const refresh = () => {
    leads.reload();
    batches.reload();
  };

  return (
    <>
      <div className="card">
        <div className="row between">
          <div>
            <h2>Importación de leads</h2>
            <p className="hint">Excel (.xlsx) o CSV, hasta {fmtNum(meta.data?.maxRows || 25000)} filas y {Math.round((meta.data?.maxBytes || 20971520) / 1048576)} MB por archivo. Puedes agregar lotes con la campaña detenida o en ejecución; el historial se conserva.</p>
          </div>
          <FilePick
            label={busy ? 'Leyendo…' : 'Importar archivo'}
            accept=".csv,.xlsx"
            disabled={busy}
            onPick={(f) => run(async () => { const r = await upload(`/campaigns/${campaignId}/imports/upload`, f); setWizard({ ...r, mapping: r.suggestedMapping, fixedType: '', name: f.name }); })}
          />
        </div>
        {batches.data?.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Lote</th><th>Estado</th><th>Filas</th><th>Aceptados</th><th>Elegibles</th><th>Tel. inválido</th><th>Duplicados</th><th>Suprimidos</th><th>Fecha</th></tr></thead>
              <tbody>
                {batches.data.map((b) => (
                  <tr key={b.id}>
                    <td><b>{b.name || b.fileName}</b>{b.truncated && <div className="small" style={{ color: 'var(--warn)' }}>Se usaron las primeras {fmtNum(meta.data?.maxRows)} de {fmtNum(b.totalInFile)} filas</div>}{b.error && <div className="small" style={{ color: 'var(--danger)' }}>{b.error}</div>}</td>
                    <td><StatusBadge status={b.status} /></td>
                    <td>{fmtNum(b.stats?.total ?? b.totalInFile)}</td>
                    <td>{fmtNum(b.stats?.accepted)}</td>
                    <td>{fmtNum(b.stats?.eligible)}</td>
                    <td>{fmtNum(b.stats?.invalidPhone)}</td>
                    <td>{fmtNum((b.stats?.duplicatesInFile || 0) + (b.stats?.duplicatesInCampaign || 0))}</td>
                    <td>{fmtNum(b.stats?.suppressed)}</td>
                    <td className="small muted">{fmtDate(b.createdAt)} {b.errors?.length > 0 && <details><summary>{b.errors.length} observaciones</summary><ul>{b.errors.slice(0, 50).map((e: any, i: number) => <li key={i}>Fila {e.row}: {e.reason} {e.phone && `(${e.phone})`}</li>)}</ul></details>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: 2 }}><Field label="Buscar (nombre, apellido, teléfono o correo)"><input type="search" value={filters.search} onChange={(e) => setF('search', e.target.value)} /></Field></div>
          <Field label="Elegibilidad"><Select value={filters.eligible} onChange={(v) => setF('eligible', v)} options={[['', 'Todos'], ['true', 'Elegibles'], ['false', 'No elegibles']]} /></Field>
          <Field label="Estado"><Select value={filters.status} onChange={(v) => setF('status', v)} options={STATUS_OPTS} /></Field>
          <Field label="Tipo"><Select value={filters.type} onChange={(v) => setF('type', v)} options={TYPE_OPTS} /></Field>
          <Field label="Lote"><Select value={filters.batchId} onChange={(v) => setF('batchId', v)} options={[['', 'Todos'], ...((batches.data || []).map((b) => [b.id, b.name || b.fileName]) as any)]} /></Field>
          <Field label="Por página"><Select value={filters.limit} onChange={(v) => setF('limit', v)} options={['25', '50', '100', '200']} /></Field>
        </div>
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="small muted">Limpieza:</span>
          {['PENDING', 'FAILED', 'CANCELLED'].map((s) => (
            <button key={s} className="btn sm danger" disabled={busy} onClick={() => confirm(`¿Quitar de la campaña todos los leads en estado ${LEAD_STATUS_LABEL[s]}${filters.batchId ? ' del lote seleccionado' : ''}? No afecta la lista de supresión.`) && run(() => post(`/campaigns/${campaignId}/leads/purge`, { status: s, batchId: filters.batchId || undefined }).then((r) => { refresh(); return r; }), 'Leads retirados')}>
              Quitar {LEAD_STATUS_LABEL[s].toLowerCase()}s
            </button>
          ))}
        </div>
        {leads.loading ? <Loading /> : <LeadTable items={leads.data?.items || []} onOpen={openLead} />}
        <div className="row end" style={{ marginTop: 10 }}>
          <button className="btn sm" disabled={!stack.length} onClick={() => setStack(stack.slice(0, -1))}>← Anterior</button>
          <button className="btn sm" disabled={!leads.data?.nextCursor} onClick={() => setStack([...stack, leads.data.nextCursor])}>Siguiente →</button>
        </div>
      </div>

      {wizard && (
        <Modal title={`Mapear columnas · ${fmtNum(wizard.totalRows)} filas`} onClose={() => setWizard(null)} wide>
          {wizard.truncated && <div className="alert warn">El archivo excede {fmtNum(wizard.maxRows)} filas: solo se importarán las primeras {fmtNum(wizard.maxRows)}. Divide la base en lotes para conservar el control de procedencia.</div>}
          <div className="grid2">
            <Field label="Nombre del lote / fuente"><Text value={wizard.name} onChange={(v) => setWizard({ ...wizard, name: v })} /></Field>
            <Field label="Tipo fijo (si el archivo no trae la columna de tipo)"><Select value={wizard.fixedType} onChange={(v) => setWizard({ ...wizard, fixedType: v })} options={[['', '— Usar columna del archivo —'], ['NOT_CONTACTED', 'No contactado'], ['ABANDONED', 'Abandonado'], ['REJECTED', 'Rechazado']]} /></Field>
          </div>
          <div className="grid3">
            {(meta.data?.leadFields || []).map((f: any) => (
              <Field key={f.key} label={<>{f.label}{f.required && <span style={{ color: 'var(--danger)' }}> *</span>} <span className="muted small">({f.group})</span></>}>
                <Select value={wizard.mapping[f.key] || ''} onChange={(v) => setWizard({ ...wizard, mapping: { ...wizard.mapping, [f.key]: v } })} options={[['', '— No mapear —'], ...wizard.columns.map((c: string) => [c, c])]} />
              </Field>
            ))}
          </div>
          <h3>Muestra</h3>
          <div className="tbl-wrap" style={{ maxHeight: 220 }}>
            <table className="tbl"><thead><tr>{wizard.columns.map((c: string) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{wizard.sample.map((r: any, i: number) => <tr key={i}>{wizard.columns.map((c: string) => <td key={c} className="small">{String(r[c] ?? '')}</td>)}</tr>)}</tbody></table>
          </div>
          <div className="alert info" style={{ marginTop: 12 }}>
            Validaciones: teléfono normalizado y obligatorio · un teléfono único por campaña (se conserva el lead más reciente por fecha) · supresiones y opt-out · consentimiento. “Cargado” no equivale a “elegible”.
          </div>
          <div className="row end">
            <button className="btn primary" disabled={busy || !wizard.mapping.phone || (!wizard.mapping.type && !wizard.fixedType)} onClick={() => run(() => post(`/campaigns/${campaignId}/imports/${wizard.batchId}/commit`, { mapping: wizard.mapping, fixedType: wizard.fixedType || null, name: wizard.name }).then(() => { setWizard(null); setTimeout(refresh, 1500); }), 'Importación en proceso')}>
              Iniciar carga
            </button>
          </div>
        </Modal>
      )}
      {detail && <LeadDetail campaignId={campaignId} campaign={campaign} detail={detail} onClose={() => setDetail(null)} onChange={() => { refresh(); openLead(detail.lead.id); }} />}
    </>
  );
}

export function LeadTable({ items, onOpen }: { items: any[]; onOpen: (id: string) => void }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead><tr><th>Lead</th><th>Teléfono</th><th>Tipo</th><th>Vehículo</th><th>Elegible</th><th>Estado</th><th>Resultado</th><th>Ánimo</th><th>CRM</th><th>Último envío</th></tr></thead>
        <tbody>
          {items.map((l) => (
            <tr key={l.id} className="click" onClick={() => onOpen(l.id)}>
              <td><b>{[l.firstName, l.lastName].filter(Boolean).join(' ') || '—'}</b><div className="small muted">{l.email}</div></td>
              <td className="mono small">{l.phone}</td>
              <td className="small">{LEAD_TYPE_LABEL[l.type]}</td>
              <td className="small">{[l.brand, l.model, l.version, l.year].filter(Boolean).join(' ')}</td>
              <td>{l.eligible ? <span className="badge ok">Sí</span> : <span className="badge err" title={l.ineligibleReason}>{l.ineligibleReason || 'No'}</span>}</td>
              <td><StatusBadge status={l.status} /></td>
              <td className="small">{l.outcome ? OUTCOME_LABEL[l.outcome] : '—'}</td>
              <td className="small">{l.evaluation?.mood || '—'}{l.evaluation?.anger ? ' 😠' : ''}</td>
              <td className="small">{l.crm?.status ? <StatusBadge status={l.crm.status} /> : '—'}</td>
              <td className="small muted">{fmtDate(l.lastSentAt)}</td>
            </tr>
          ))}
          {!items.length && <tr><td colSpan={10} className="empty">Sin leads para los filtros.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function LeadDetail({ campaignId, detail, onClose, onChange }: { campaignId: string; campaign: any; detail: any; onClose: () => void; onChange: () => void }) {
  const { lead, attempts, messages } = detail;
  const { busy, run } = useAction();
  const [preview, setPreview] = useState<any>(null);
  return (
    <Modal title={`${[lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.phone}`} onClose={onClose} wide>
      <div className="row" style={{ marginBottom: 12 }}>
        <StatusBadge status={lead.status} /> {lead.outcome && <span className="badge info">{OUTCOME_LABEL[lead.outcome]}</span>}
        <div className="spacer" />
        <button className="btn sm" onClick={() => run(async () => setPreview(await get(`/campaigns/${campaignId}/leads/${lead.id}/preview`)))}>Vista previa del mensaje</button>
        {['FAILED', 'CANCELLED'].includes(lead.status) && <button className="btn sm" disabled={busy} onClick={() => run(() => post(`/campaigns/${campaignId}/leads/${lead.id}/retry`).then(onChange), 'Reintento programado')}>Reintentar envío</button>}
        <button className="btn sm" disabled={busy} onClick={() => run(() => patch(`/campaigns/${campaignId}/leads/${lead.id}`, { eligible: !lead.eligible }).then(onChange), 'Elegibilidad actualizada')}>{lead.eligible ? 'Marcar no elegible' : 'Marcar elegible'}</button>
        <button className="btn sm danger" disabled={busy} onClick={() => confirm('¿Bloquear este teléfono en TODAS las campañas?') && run(() => post(`/campaigns/${campaignId}/leads/${lead.id}/block`, { reason: 'Bloqueo manual' }).then(onChange), 'Teléfono bloqueado')}>Bloquear teléfono</button>
        <button className="btn sm danger" disabled={busy} onClick={() => confirm('¿Quitar este lead de la campaña? (No lo bloquea globalmente)') && run(() => del(`/campaigns/${campaignId}/leads/${lead.id}`).then(() => { onClose(); onChange(); }), 'Lead retirado')}>Quitar de campaña</button>
      </div>
      {preview && <div className="alert info"><b>{preview.template}</b> ({preview.language}) · parámetros: {JSON.stringify(preview.params)}<br />{preview.text || preview.error}</div>}
      <div className="grid2">
        <div>
          <h3>Datos</h3>
          <table className="tbl small"><tbody>
            {[
              ['Teléfono', lead.phone], ['Correo', lead.email], ['CP', lead.zip], ['ID origen', lead.sourceId], ['Tipo', LEAD_TYPE_LABEL[lead.type]], ['Motivo previo', lead.reason],
              ['Vehículo', [lead.brand, lead.model, lead.version, lead.year].filter(Boolean).join(' ')], ['Distribuidor original', `${lead.originalDealerName || ''} ${lead.originalDealerId ? `(${lead.originalDealerId})` : ''}`],
              ['Fecha original', lead.originalDate], ['Resumen', lead.summary], ['Lote', lead.batchName], ['Cargado', fmtDate(lead.importedAt)], ['Elegible', lead.eligible ? 'Sí' : `No (${lead.ineligibleReason || ''})`],
              ['Intentos', lead.attempts], ['Distribuidor elegido', lead.selectedDealer?.name], ['CRM', lead.crm ? `${lead.crm.status}${lead.crm.externalId ? ' · ID ' + lead.crm.externalId : ''}${lead.crm.error ? ' · ' + lead.crm.error : ''}` : ''],
              ['Evaluación', lead.evaluation ? `ánimo ${lead.evaluation.mood || '—'} · intención ${lead.evaluation.purchaseIntent || '—'} · prob. ${lead.evaluation.recoveryProbability ?? '—'}${lead.evaluation.complaint ? ' · queja' : ''}${lead.evaluation.optOut ? ' · opt-out' : ''}` : ''],
            ].map(([k, v]) => <tr key={k as string}><td className="muted">{k}</td><td>{v || '—'}</td></tr>)}
          </tbody></table>
          <h3 style={{ marginTop: 12 }}>Intentos de contacto</h3>
          {attempts.map((a: any) => (
            <div className="list-item small" key={a.id}>
              <div className="row between"><b>Intento {a.attemptNumber}</b><StatusBadge status={a.status} /></div>
              <div>Plantilla: {a.template || '—'} ({a.language || ''}) · Línea: {a.lineId} · Ejecución: {a.executionId || '—'}</div>
              <div className="muted">Programado {fmtDate(a.scheduledAt)} · inicio {fmtDate(a.startedAt)} · fin {fmtDate(a.finishedAt)} · WA ID {a.waMessageId || '—'}</div>
              {a.statusHistory?.length > 0 && <div>Eventos: {a.statusHistory.map((h: any) => `${h.status} ${new Date(h.at).toLocaleString('es-MX')}`).join(' → ')}</div>}
              {a.error && <div style={{ color: 'var(--danger)' }}>Error {a.error.code || ''}: {a.error.message} {a.error.details || ''}</div>}
              {a.cancelReason && <div className="muted">{a.cancelReason}</div>}
            </div>
          ))}
          {!attempts.length && <div className="muted small">Sin intentos.</div>}
        </div>
        <div>
          <h3>Conversación</h3>
          <Transcript messages={messages} />
        </div>
      </div>
    </Modal>
  );
}

/* ============================== EJECUCIÓN ============================== */
export function ExecutionTab({ campaignId, campaign, onChange }: { campaignId: string; campaign: any; onChange: () => void }) {
  const pv = useAsync(() => get(`/campaigns/${campaignId}/prevalidate`), [campaignId, campaign.status]);
  const execs = useAsync(() => get<any[]>(`/campaigns/${campaignId}/executions`), [campaignId, campaign.status]);
  const errors = useAsync(() => get<any[]>(`/campaigns/${campaignId}/errors`), [campaignId]);
  const attempts = useAsync(() => get<any[]>(`/campaigns/${campaignId}/attempts?limit=50`), [campaignId]);
  const { busy, run } = useAction();
  const s = campaign.status;
  const act = (path: string, msg: string) => run(() => post(`/campaigns/${campaignId}/${path}`).then(() => { onChange(); pv.reload(); execs.reload(); }), msg);

  return (
    <>
      <div className="card">
        <div className="row between">
          <div>
            <h2>Control de ejecución</h2>
            <p className="hint">Estado actual: <StatusBadge status={s} /> {campaign.lastTickNote && <span className="small muted">· {campaign.lastTickNote}</span>}</p>
          </div>
          <div className="row">
            {['draft', 'cancelled', 'completed'].includes(s) && <button className="btn primary" disabled={busy || !pv.data?.ok} onClick={() => confirm('¿Iniciar la campaña? Se enviarán plantillas de WhatsApp a los leads elegibles.') && act('start', 'Campaña iniciada')}>Iniciar</button>}
            {s === 'running' && <button className="btn" disabled={busy} onClick={() => act('pause', 'Campaña en pausa')}>Pausar</button>}
            {s === 'paused' && <button className="btn primary" disabled={busy} onClick={() => act('resume', 'Campaña reanudada')}>Reanudar</button>}
            {['running', 'paused'].includes(s) && <button className="btn danger" disabled={busy} onClick={() => confirm('¿Cancelar la ejecución? Se liberan los envíos aún no realizados; no se puede retirar lo ya enviado.') && act('cancel', 'Ejecución cancelada')}>Cancelar ejecución</button>}
            <button className="btn" disabled={busy} onClick={() => run(() => post('/campaigns/tick'), 'Ciclo de envío solicitado')}>Procesar ahora</button>
          </div>
        </div>
        <h3>Prevalidación</h3>
        {pv.loading ? <Loading /> : (
          <ul className="check-list" style={{ listStyle: 'none', padding: 0 }}>
            {pv.data?.checks.map((c: any) => (
              <li key={c.key}>
                {c.ok ? '✅' : c.severity === 'warning' ? '⚠️' : '❌'} <b>{c.label}</b> <span className="muted small">{c.detail}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="small muted">Una prevalidación satisfactoria no garantiza que WhatsApp acepte cada mensaje individual (plantilla aprobada, permisos, límites de la cuenta).</div>
        <button className="btn sm" style={{ marginTop: 8 }} onClick={pv.reload}>Volver a validar</button>
      </div>

      <div className="grid2">
        <div className="card">
          <h3>Errores de envío por causa</h3>
          {errors.data?.length ? errors.data.map((e: any, i: number) => (
            <div className="list-item small" key={i}>
              <div className="row between"><b>Código {e.code || '—'}</b><span className="badge err">{e.count}</span></div>
              <div>{e.message}</div>{e.details && <div className="muted">{e.details}</div>}
              <div className="muted">Líneas: {e.lines.join(', ')} · Plantillas: {e.templates.join(', ') || '—'}</div>
            </div>
          )) : <div className="muted small">Sin errores.</div>}
        </div>
        <div className="card">
          <h3>Ejecuciones</h3>
          <table className="tbl small"><thead><tr><th>Inicio</th><th>Estado</th><th>Por</th></tr></thead>
            <tbody>{(execs.data || []).map((e) => <tr key={e.id}><td>{fmtDate(e.startedAt)}</td><td><StatusBadge status={e.status} /></td><td>{e.startedBy}</td></tr>)}</tbody></table>
        </div>
      </div>

      <div className="card">
        <div className="row between"><h3>Últimos intentos</h3><button className="btn sm" onClick={attempts.reload}>Actualizar</button></div>
        <div className="tbl-wrap"><table className="tbl small">
          <thead><tr><th>Creado</th><th>Lead</th><th>Intento</th><th>Línea</th><th>Plantilla</th><th>Estado</th><th>Canal</th><th>Error</th></tr></thead>
          <tbody>{(attempts.data || []).map((a) => (
            <tr key={a.id}><td>{fmtDate(a.createdAt)}</td><td className="mono">{a.leadId}</td><td>{a.attemptNumber}</td><td>{a.lineId}</td><td>{a.template || '—'}</td><td><StatusBadge status={a.status} /></td><td>{a.channelStatus || ''}</td><td style={{ color: 'var(--danger)' }}>{a.error ? `${a.error.code || ''} ${a.error.message}` : ''}</td></tr>
          ))}</tbody>
        </table></div>
      </div>
    </>
  );
}

/* ============================== REPORTES ============================== */
export function ReportsTab({ campaignId, campaign }: { campaignId: string; campaign: any }) {
  const [f, setF] = useState({ from: '', to: '', type: '', status: '', mood: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as any).toString();
  const rep = useAsync(() => get(`/campaigns/${campaignId}/report?${qs}`), [campaignId, qs]);
  const [listF, setListF] = useState({ status: '', outcome: '', type: '' });
  const lqs = new URLSearchParams(Object.entries({ ...listF, limit: '50' }).filter(([, v]) => v) as any).toString();
  const list = useAsync(() => get(`/campaigns/${campaignId}/leads?${lqs}`), [campaignId, lqs]);
  const [detail, setDetail] = useState<any>(null);
  const { busy, run } = useAction();
  const K = rep.data?.kpis;
  const R = rep.data?.rates;

  return (
    <>
      <div className="card no-print-filters">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Desde"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="Hasta"><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Field label="Tipo de lead"><Select value={f.type} onChange={(v) => setF({ ...f, type: v })} options={TYPE_OPTS} /></Field>
          <Field label="Estado / resultado"><Select value={f.status} onChange={(v) => setF({ ...f, status: v })} options={[...STATUS_OPTS, ...Object.entries(OUTCOME_LABEL)] as any} /></Field>
          <Field label="Ánimo"><Select value={f.mood} onChange={(v) => setF({ ...f, mood: v })} options={[['', 'Todos'], ['positive', 'Positivo'], ['neutral', 'Neutral'], ['negative', 'Negativo'], ['undetermined', 'Indeterminado']]} /></Field>
          <div className="spacer" />
          <button className="btn" onClick={rep.reload}>Actualizar</button>
          <button className="btn" disabled={busy} onClick={() => run(() => download(`/campaigns/${campaignId}/export`, `campana-${campaignId}.csv`))}>Exportar campaña (CSV)</button>
          <button className="btn" onClick={() => window.print()}>Reporte ejecutivo (PDF)</button>
        </div>
      </div>
      {rep.loading || !K ? <Loading /> : (
        <>
          <h2>{campaign.name}</h2>
          <p className="muted small">Generado {fmtDate(rep.data.generatedAt)} · filtros: {qs || 'ninguno'}</p>
          <div className="grid4" style={{ marginBottom: 12 }}>
            <Stat label="Leads (filtro)" value={fmtNum(K.leads)} sub={`${fmtNum(K.eligible)} elegibles · ${fmtNum(K.pending)} pendientes`} />
            <Stat label="Enviados" value={fmtNum(K.sent)} />
            <Stat label="Entregados" value={fmtNum(K.delivered)} sub={`${pct(R.deliveryRate)} · leídos ${fmtNum(K.read)} (${pct(R.readRate)})`} />
            <Stat label="Respondidos" value={fmtNum(K.replied)} sub={`${pct(R.responseRate)} de enviados`} />
          </div>
          <div className="grid4" style={{ marginBottom: 12 }}>
            <Stat label="Recuperados" value={fmtNum(K.recovered)} sub={`${pct(R.recoveryOverReplied)} de respondidos · ${pct(R.recoveryOverSent)} de enviados`} />
            <Stat label="Transferencias CRM" value={fmtNum(K.crmTransfers)} sub={`${fmtNum(K.crmErrors)} con error`} />
            <Stat label="Opt-out" value={fmtNum(K.optOut)} sub={pct(R.optOutRate)} />
            <Stat label="Errores de envío" value={fmtNum(K.errors)} />
          </div>
          <div className="grid4" style={{ marginBottom: 12 }}>
            <Stat label="Conversaciones activas" value={fmtNum(K.activeConversations)} sub={`${fmtNum(K.interested)} con interés`} />
            <Stat label="Sin respuesta" value={fmtNum(K.noResponse)} />
            <Stat label="Ánimo" value={`${K.positive} / ${K.neutral} / ${K.negative}`} sub={`positivas / neutrales / negativas · ${K.undetermined} indeterminadas`} />
            <Stat label="Enojo / quejas" value={`${K.anger} / ${K.complaints}`} />
          </div>
          <div className="card">
            <h3>Por tipo de lead</h3>
            <table className="tbl"><thead><tr><th>Tipo</th><th>Leads</th><th>Enviados</th><th>Respondidos</th><th>Recuperados</th><th>% recuperación / enviados</th></tr></thead>
              <tbody>{Object.entries<any>(K.byType).map(([t, v]) => <tr key={t}><td>{LEAD_TYPE_LABEL[t]}</td><td>{fmtNum(v.leads)}</td><td>{fmtNum(v.sent)}</td><td>{fmtNum(v.replied)}</td><td>{fmtNum(v.recovered)}</td><td>{pct(v.sent ? (v.recovered / v.sent) * 100 : 0)}</td></tr>)}</tbody></table>
          </div>
          <div className="small muted" style={{ marginBottom: 12 }}>Las tasas son indicadores de seguimiento, no equivalen a ventas facturadas. % respuesta y % recuperación se calculan sobre leads con al menos un envío.</div>
        </>
      )}
      <div className="card no-print">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <h3 style={{ flex: 1 }}>Leads de la campaña</h3>
          <Field label="Estado"><Select value={listF.status} onChange={(v) => setListF({ ...listF, status: v })} options={STATUS_OPTS} /></Field>
          <Field label="Resultado"><Select value={listF.outcome} onChange={(v) => setListF({ ...listF, outcome: v })} options={[['', 'Todos'], ...Object.entries(OUTCOME_LABEL)] as any} /></Field>
          <Field label="Tipo"><Select value={listF.type} onChange={(v) => setListF({ ...listF, type: v })} options={TYPE_OPTS} /></Field>
        </div>
        {list.loading ? <Loading /> : <LeadTable items={list.data?.items || []} onOpen={(id) => run(async () => setDetail(await get(`/campaigns/${campaignId}/leads/${id}`)))} />}
      </div>
      {detail && <LeadDetail campaignId={campaignId} campaign={campaign} detail={detail} onClose={() => setDetail(null)} onChange={() => list.reload()} />}
    </>
  );
}

export { Check };
