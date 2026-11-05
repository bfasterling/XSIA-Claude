import { get, patch } from '../../lib/api';
import { fmtDate } from '../../lib/format';
import { Check, Loading, Select, useAction, useAsync } from '../../components/ui';

export default function Users() {
  const { data, loading, reload } = useAsync(() => get<any[]>('/users'), []);
  const { run } = useAction();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Usuarios y permisos</h1>
          <p>Los usuarios aparecen aquí después de iniciar sesión por primera vez. Admin: todo · Operador: configurar y operar · Lector: solo consulta.</p>
        </div>
      </div>
      {loading ? <Loading /> : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Correo</th><th>Rol</th><th>Deshabilitado</th><th>Alta</th></tr></thead>
            <tbody>
              {(data || []).map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td style={{ width: 200 }}>
                    <Select value={u.role || ''} onChange={(v) => run(() => patch(`/users/${u.id}`, { role: v || null }).then(reload), 'Rol actualizado')} options={[['', 'Sin acceso'], ['viewer', 'Lector'], ['operator', 'Operador'], ['admin', 'Administrador']]} />
                  </td>
                  <td><Check checked={!!u.disabled} onChange={(v) => run(() => patch(`/users/${u.id}`, { disabled: v }).then(reload))} label="" /></td>
                  <td className="small muted">{fmtDate(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
