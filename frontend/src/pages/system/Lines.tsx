import { useState } from 'react';
import { del, get, patch, post } from '../../lib/api';
import { Area, Check, Field, Loading, Modal, Num, Select, Text, useAction, useAsync } from '../../components/ui';

export default function Lines() {
  const { data, loading, reload } = useAsync(() => get<any[]>('/lines'), []);
  const info = useAsync(() => get('/lines/webhook-info'), []);
  const agents = useAsync(() => get<any[]>('/agents'), []);
  const { busy, run } = useAction();
  const [edit, setEdit] = useState<any>(null);
  const [test, setTest] = useState<any>(null);
  const [result, setResult] = useState<any>(null);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Líneas de WhatsApp</h1>
          <p>Números de WhatsApp Business Platform (Cloud API de Meta) disponibles para agentes y campañas.</p>
        </div>
        <button className="btn primary" onClick={() => setEdit({ name: '', phoneNumberId: '', wabaId: '', displayPhone: '', accessToken: '', dailyLimit: 250, enabled: true, defaultAgentId: '' })}>+ Agregar línea</button>
      </div>
      {info.data && (
        <div className="card">
          <h2>Webhook de Meta</h2>
          <p className="hint">Configura en Meta App Dashboard → WhatsApp → Configuración. Suscribe los campos <b>messages</b> (incluye estados).</p>
          <div className="grid2">
            <Field label="URL de devolución de llamada"><code>{info.data.callbackUrl}</code></Field>
            <Field label="Estado de secretos">
              <div className="row">
                <span className={`badge ${info.data.verifyTokenConfigured ? 'ok' : 'err'}`}>Verify token {info.data.verifyTokenConfigured ? 'configurado' : 'faltante'}</span>
                <span className={`badge ${info.data.appSecretConfigured ? 'ok' : 'err'}`}>App secret {info.data.appSecretConfigured ? 'configurado' : 'faltante'}</span>
                <span className="badge">Graph {info.data.graphVersion}</span>
              </div>
            </Field>
          </div>
        </div>
      )}
      {loading ? <Loading /> : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Línea</th><th>Phone number ID</th><th>WABA</th><th>Límite diario</th><th>Usados hoy</th><th>Agente por defecto</th><th>Estado</th><th></th></tr></thead>
            <tbody>
              {(data || []).map((l) => (
                <tr key={l.id}>
                  <td><b>{l.name}</b><div className="small muted">{l.displayPhone}</div></td>
                  <td className="mono small">{l.phoneNumberId}</td>
                  <td className="mono small">{l.wabaId}</td>
                  <td>{l.dailyLimit}</td>
                  <td>{l.usedToday}</td>
                  <td className="small">{(agents.data || []).find((a) => a.id === l.defaultAgentId)?.name || '—'}</td>
                  <td><Check checked={l.enabled} onChange={(v) => run(() => patch(`/lines/${l.id}`, { enabled: v }).then(reload), v ? 'Línea habilitada' : 'Línea deshabilitada')} label={l.enabled ? 'Habilitada' : 'Deshabilitada'} /></td>
                  <td className="row" style={{ gap: 6 }}>
                    <button className="btn sm" onClick={() => { setTest({ id: l.id, to: '', text: '', template: '', language: 'es_MX', params: '' }); setResult(null); }}>Prueba</button>
                    <button className="btn sm" onClick={() => setEdit(l)}>Editar</button>
                    <button className="btn sm danger" onClick={() => confirm('¿Eliminar línea?') && run(() => del(`/lines/${l.id}`).then(reload))}>Eliminar</button>
                  </td>
                </tr>
              ))}
              {!data?.length && <tr><td colSpan={8} className="empty">Sin líneas.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <Modal title={edit.id ? 'Editar línea' : 'Nueva línea'} onClose={() => setEdit(null)}>
          <div className="grid2">
            <Field label="Nombre"><Text value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} /></Field>
            <Field label="Teléfono visible"><Text value={edit.displayPhone} onChange={(v) => setEdit({ ...edit, displayPhone: v })} placeholder="+52 55 1234 5678" /></Field>
            <Field label="Phone number ID"><Text value={edit.phoneNumberId} onChange={(v) => setEdit({ ...edit, phoneNumberId: v })} /></Field>
            <Field label="WhatsApp Business Account ID"><Text value={edit.wabaId} onChange={(v) => setEdit({ ...edit, wabaId: v })} /></Field>
          </div>
          <Field label="Token de acceso (System User permanente)" help="Se almacena solo en el servidor; aquí se muestra enmascarado."><Text value={edit.accessToken} onChange={(v) => setEdit({ ...edit, accessToken: v })} /></Field>
          <div className="grid3">
            <Field label="Límite diario de conversaciones iniciadas" help="Según el nivel vigente de la cuenta en Meta"><Num value={edit.dailyLimit} onChange={(v) => setEdit({ ...edit, dailyLimit: v })} /></Field>
            <Field label="Agente por defecto (entrantes)"><Select value={edit.defaultAgentId} onChange={(v) => setEdit({ ...edit, defaultAgentId: v })} options={[['', '—'], ...((agents.data || []).map((a) => [a.id, a.name]) as any)]} /></Field>
            <Field label="Estado"><Check checked={edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} label="Habilitada" /></Field>
          </div>
          <div className="row end">
            <button className="btn primary" disabled={busy} onClick={() => run(() => (edit.id ? patch(`/lines/${edit.id}`, edit) : post('/lines', edit)).then(() => { setEdit(null); reload(); }), 'Línea guardada')}>Guardar</button>
          </div>
        </Modal>
      )}
      {test && (
        <Modal title="Envío de prueba controlado" onClose={() => setTest(null)}>
          <Field label="Teléfono destino"><Text value={test.to} onChange={(v) => setTest({ ...test, to: v })} placeholder="5512345678" /></Field>
          <div className="grid2">
            <Field label="Plantilla (opcional)" help="Para iniciar conversación se requiere plantilla aprobada"><Text value={test.template} onChange={(v) => setTest({ ...test, template: v })} /></Field>
            <Field label="Idioma"><Text value={test.language} onChange={(v) => setTest({ ...test, language: v })} /></Field>
          </div>
          {test.template ? (
            <Field label="Parámetros (separados por |)"><Text value={test.params} onChange={(v) => setTest({ ...test, params: v })} placeholder="Juan|Jeep|Compass|10% de descuento" /></Field>
          ) : (
            <Field label="Texto libre (solo dentro de la ventana de 24 h)"><Area value={test.text} onChange={(v) => setTest({ ...test, text: v })} /></Field>
          )}
          <button className="btn primary" disabled={busy || !test.to} onClick={() => run(async () => setResult(await post(`/lines/${test.id}/test`, { ...test, params: test.params ? test.params.split('|') : [] })))}>Enviar</button>
          {result && <pre style={{ marginTop: 12 }}>{JSON.stringify(result, null, 2)}</pre>}
        </Modal>
      )}
    </>
  );
}
