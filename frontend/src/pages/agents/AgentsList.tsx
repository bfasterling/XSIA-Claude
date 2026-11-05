import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { del, get, post } from '../../lib/api';
import { fmtDate } from '../../lib/format';
import { ErrorBox, Field, Loading, Modal, StatusBadge, Text, useAction, useAsync } from '../../components/ui';

export default function AgentsList() {
  const { data, error, loading, reload } = useAsync(() => get<any[]>('/agents'), []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const { busy, run } = useAction();
  const nav = useNavigate();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agentes</h1>
          <p>Asesores conversacionales con identidad, conocimiento, herramientas y canales propios.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>+ Nuevo agente</button>
      </div>
      <ErrorBox error={error} />
      {loading ? (
        <Loading />
      ) : !data?.length ? (
        <div className="card empty">Aún no hay agentes. Crea el primero.</div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Agente</th><th>Acceso directo</th><th>Canales</th><th>Estado</th><th>Actualizado</th><th></th></tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to={`/admin/agents/${a.id}`}><b>{a.name}</b></Link>
                    <div className="muted small">{a.description}</div>
                  </td>
                  <td><a href={`/c/${a.slug}`} target="_blank" rel="noreferrer" className="mono small">/c/{a.slug}</a></td>
                  <td className="row" style={{ gap: 4 }}>
                    {a.channels.web && <span className="badge info">Web</span>}
                    {a.channels.whatsapp && <span className="badge ok">WhatsApp</span>}
                    {a.channels.voice && <span className="badge warn">Voz</span>}
                  </td>
                  <td><StatusBadge status={a.status} /></td>
                  <td className="small muted">{fmtDate(a.updatedAt)}</td>
                  <td>
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <Link className="btn sm" to={`/admin/agents/${a.id}`}>Editar</Link>
                      <a className="btn sm" href={`/c/${a.slug}`} target="_blank" rel="noreferrer">Probar chat</a>
                      <Link className="btn sm" to={`/admin/agents/${a.id}/dashboard`}>Reportes</Link>
                      <button
                        className="btn sm"
                        disabled={busy}
                        onClick={() => run(async () => { const r = await post(`/agents/${a.id}/duplicate`, {}); nav(`/admin/agents/${r.id}`); }, 'Agente duplicado')}
                      >Duplicar</button>
                      <button
                        className="btn sm danger"
                        disabled={busy}
                        onClick={() => confirm(`¿Eliminar el agente "${a.name}" y todo su conocimiento?`) && run(() => del(`/agents/${a.id}`).then(reload), 'Agente eliminado')}
                      >Eliminar</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <Modal title="Nuevo agente" onClose={() => setCreating(false)}>
          <Field label="Nombre" help="Marca, producto, línea de negocio o caso de uso que representa.">
            <Text value={name} onChange={setName} autoFocus />
          </Field>
          <div className="row end">
            <button
              className="btn primary"
              disabled={!name || busy}
              onClick={() => run(async () => { const r = await post('/agents', { name }); nav(`/admin/agents/${r.id}`); })}
            >Crear</button>
          </div>
        </Modal>
      )}
    </>
  );
}
