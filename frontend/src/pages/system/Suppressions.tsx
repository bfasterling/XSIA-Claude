import { useState } from 'react';
import { del, get, post } from '../../lib/api';
import { fmtDate } from '../../lib/format';
import { Area, Field, Loading, Text, useAction, useAsync } from '../../components/ui';

export default function Suppressions() {
  const [q, setQ] = useState('');
  const { data, loading, reload } = useAsync(() => get<any[]>(`/suppressions${q ? `?phone=${encodeURIComponent(q)}` : ''}`), [q]);
  const { busy, run } = useAction();
  const [phones, setPhones] = useState('');
  const [reason, setReason] = useState('');
  const [lookup, setLookup] = useState<any>(null);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Lista de supresión (no contactar)</h1>
          <p>Teléfonos que no deben recibir mensajes en ninguna campaña. Distinto de quitar un lead de una campaña o marcarlo no elegible.</p>
        </div>
      </div>
      <div className="grid2">
        <div className="card">
          <h2>Bloquear teléfonos</h2>
          <Field label="Teléfonos (uno por línea)"><Area value={phones} onChange={setPhones} /></Field>
          <Field label="Motivo"><Text value={reason} onChange={setReason} placeholder="Solicitud del cliente" /></Field>
          <button className="btn primary" disabled={busy || !phones.trim()} onClick={() => run(() => post('/suppressions', { phones: phones.split(/\s*\n\s*/).filter(Boolean), reason }).then(() => { setPhones(''); reload(); }), 'Teléfonos bloqueados')}>Bloquear</button>
        </div>
        <div className="card">
          <h2>Buscar teléfono en todas las campañas</h2>
          <div className="row"><input type="search" placeholder="5512345678" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn" disabled={!q} onClick={() => run(async () => setLookup(await get(`/recovery/phone/${encodeURIComponent(q)}`)))}>Consultar</button></div>
          {lookup && (
            <div style={{ marginTop: 10 }} className="small">
              <div><b>{lookup.phone}</b> · {lookup.suppression?.active !== false && lookup.suppression ? <span className="badge err">Suprimido</span> : <span className="badge ok">Sin supresión</span>}</div>
              {lookup.leads.map((l: any) => <div key={l.campaignId}>Campaña {l.campaignId}: {l.status} {l.outcome || ''}</div>)}
            </div>
          )}
        </div>
      </div>
      {loading ? <Loading /> : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Teléfono</th><th>Motivo</th><th>Origen</th><th>Fecha</th><th></th></tr></thead>
            <tbody>
              {(data || []).map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.id}</td><td>{s.reason}</td><td className="small">{s.source}</td><td className="small">{fmtDate(s.createdAt)}</td>
                  <td>{s.active !== false && <button className="btn sm" onClick={() => confirm('¿Retirar la supresión? Asegúrate de contar con autorización.') && run(() => del(`/suppressions/${s.id}`).then(reload), 'Supresión retirada')}>Retirar</button>}</td>
                </tr>
              ))}
              {!data?.length && <tr><td colSpan={5} className="empty">Sin registros.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
