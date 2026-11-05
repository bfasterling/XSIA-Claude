import { useState } from 'react';
import { del, get, upload } from '../../lib/api';
import { FilePick, Loading, useAction, useAsync } from '../../components/ui';

export default function Dealers() {
  const [search, setSearch] = useState('');
  const { data, loading, reload } = useAsync(() => get<any[]>(`/dealers?search=${encodeURIComponent(search)}`), [search]);
  const { busy, run } = useAction();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Directorio de distribuidores</h1>
          <p>Directorio interno para búsqueda por cercanía (Dealer Locator). Columnas CSV: code, name, brand, type, address, city, state, zip, lat, lng, phone, url. Si faltan coordenadas se geocodifican con Google Maps.</p>
        </div>
        <FilePick label={busy ? 'Importando…' : 'Importar CSV'} accept=".csv" disabled={busy} onPick={(f) => run(() => upload('/dealers/import', f).then((r) => { reload(); return r; }), 'Directorio actualizado')} />
      </div>
      <input type="search" placeholder="Buscar por código, nombre, ciudad o marca" value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginBottom: 12 }} />
      {loading ? <Loading /> : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Código</th><th>Nombre</th><th>Marca</th><th>Ciudad</th><th>Estado</th><th>CP</th><th>Coordenadas</th><th></th></tr></thead>
            <tbody>
              {(data || []).map((d) => (
                <tr key={d.id}>
                  <td className="mono">{d.id}</td><td>{d.name}</td><td>{d.brand}</td><td>{d.city}</td><td>{d.state}</td><td>{d.zip}</td>
                  <td className="small">{d.lat ? `${Number(d.lat).toFixed(4)}, ${Number(d.lng).toFixed(4)}` : <span className="badge warn">sin coordenadas</span>}</td>
                  <td><button className="btn sm danger" onClick={() => confirm('¿Eliminar distribuidor?') && run(() => del(`/dealers/${d.id}`).then(reload))}>Eliminar</button></td>
                </tr>
              ))}
              {!data?.length && <tr><td colSpan={8} className="empty">Sin distribuidores.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
