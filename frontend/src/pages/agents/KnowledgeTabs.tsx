import { useState } from 'react';
import { del, get, patch, post, upload } from '../../lib/api';
import { fmtDate, fmtNum } from '../../lib/format';
import { Area, Check, Field, FilePick, Loading, Modal, Num, Select, StatusBadge, Text, useAction, useAsync } from '../../components/ui';

/* ------------------------------ Documentos ------------------------------ */
export function DocumentsTab({ agent, set }: { agent: any; set: (p: string, v: any) => void }) {
  const id = agent.id;
  const { data, loading, reload } = useAsync(() => get<any[]>(`/agents/${id}/documents`), [id]);
  const { busy, run } = useAction();
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[] | null>(null);
  const files = (data || []).filter((d) => d.sourceType !== 'web');
  const processing = files.some((d) => ['queued', 'processing'].includes(d.status));

  return (
    <>
      <div className="card">
        <h2>Repositorio de documentos</h2>
        <p className="hint">
          Catálogos, fichas, condiciones comerciales, FAQ o manuales (PDF, DOCX, XLSX, CSV, TXT, MD, HTML e imágenes). Claude extrae el texto (incluso de PDFs escaneados),
          lo fragmenta, lo contextualiza y lo vectoriza para búsqueda semántica.
        </p>
        <div className="grid2">
          <Field label="Título (opcional)"><Text value={title} onChange={setTitle} placeholder="Ficha técnica Modelo X 2026" /></Field>
          <Field label="Instrucciones de uso del documento (opcional)"><Text value={instructions} onChange={setInstructions} placeholder="Úsalo para responder especificaciones técnicas" /></Field>
        </div>
        <div className="row">
          <FilePick
            label={busy ? 'Subiendo…' : 'Subir documento'}
            disabled={busy}
            accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.html,.htm,.json,.png,.jpg,.jpeg,.webp"
            onPick={(f) => run(() => upload(`/agents/${id}/documents`, f, { title, instructions }).then(() => { setTitle(''); setInstructions(''); reload(); }), 'Documento en proceso')}
          />
          <button className="btn" onClick={reload}>Actualizar</button>
          {processing && <span className="muted small"><span className="spinner" /> Procesando…</span>}
        </div>
      </div>

      <div className="card">
        {loading ? <Loading /> : !files.length ? <div className="empty">Sin documentos.</div> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Documento</th><th>Instrucciones</th><th>Estado</th><th>Fragmentos</th><th>Cargado</th><th></th></tr></thead>
              <tbody>
                {files.map((d) => (
                  <tr key={d.id}>
                    <td><b>{d.title}</b><div className="muted small">{d.name} · {d.extractMethod || ''}</div>{d.error && <div className="small" style={{ color: 'var(--danger)' }}>{d.error}</div>}</td>
                    <td className="small">
                      <input type="text" defaultValue={d.instructions} onBlur={(e) => e.target.value !== d.instructions && run(() => patch(`/agents/${id}/documents/${d.id}`, { instructions: e.target.value }), 'Guardado')} />
                    </td>
                    <td><StatusBadge status={d.status} /></td>
                    <td>{d.chunks ?? '—'}</td>
                    <td className="small muted">{fmtDate(d.createdAt)}</td>
                    <td className="row" style={{ gap: 6 }}>
                      <button className="btn sm" onClick={() => run(() => post(`/agents/${id}/documents/${d.id}/reindex`).then(reload), 'Reindexando')}>Reindexar</button>
                      <button className="btn sm danger" onClick={() => confirm('¿Retirar este documento del conocimiento?') && run(() => del(`/agents/${id}/documents/${d.id}`).then(reload), 'Documento retirado')}>Retirar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Ajustes de recuperación (RAG)</h2>
        <div className="grid4">
          <Field label="Fragmentos por consulta (top K)"><Num value={agent.rag.topK} onChange={(v) => set('rag.topK', v)} /></Field>
          <Field label="Similitud mínima (0–1)"><Num step="0.05" value={agent.rag.minScore} onChange={(v) => set('rag.minScore', v)} /></Field>
          <Field label="Contextualización con Claude" help="Mejora la precisión; aplica al indexar."><Check checked={agent.rag.contextualRetrieval} onChange={(v) => set('rag.contextualRetrieval', v)} label="Activada" /></Field>
          <Field label="Reordenamiento con Claude" help="Más preciso, añade ~1 s por consulta."><Check checked={agent.rag.rerank} onChange={(v) => set('rag.rerank', v)} label="Activado" /></Field>
        </div>
        <h3>Probar búsqueda</h3>
        <div className="row">
          <input type="search" style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="¿Qué rendimiento tiene la versión híbrida?" />
          <button className="btn" disabled={!q || busy} onClick={() => run(async () => setHits(await post(`/agents/${id}/knowledge/search`, { query: q })))}>Buscar</button>
        </div>
        {hits && (
          <div style={{ marginTop: 12 }}>
            {!hits.length && <div className="muted">Sin resultados por encima de la similitud mínima.</div>}
            {hits.map((h, i) => (
              <div className="list-item" key={i}>
                <div className="row between"><b>{h.title}</b><span className="badge info">{h.score.toFixed(3)}</span></div>
                {h.context && <div className="small muted" style={{ margin: '4px 0' }}>Contexto: {h.context}</div>}
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{h.text.slice(0, 600)}{h.text.length > 600 ? '…' : ''}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ------------------------------ Datos CSV ------------------------------ */
export function DatasetsTab({ agentId }: { agentId: string }) {
  const { data, loading, reload } = useAsync(() => get<any[]>(`/agents/${agentId}/datasets`), [agentId]);
  const { busy, run } = useAction();
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);

  return (
    <>
      <div className="card">
        <h2>Bases de información (CSV)</h2>
        <p className="hint">Información estructurada que el agente consulta con filtros (inventario, precios, sucursales…). Claude sugiere la descripción de cada campo; ajústala para mejorar la interpretación. No confundir con la importación de leads de Recovery.</p>
        <div className="grid2">
          <Field label="Nombre"><Text value={name} onChange={setName} placeholder="Inventario de vehículos" /></Field>
          <Field label="Propósito"><Text value={purpose} onChange={setPurpose} placeholder="Disponibilidad y precio por versión y color" /></Field>
        </div>
        <FilePick label={busy ? 'Procesando…' : 'Subir CSV'} accept=".csv" disabled={busy || !name} onPick={(f) => run(() => upload(`/agents/${agentId}/datasets`, f, { name, purpose }).then(() => { setName(''); setPurpose(''); reload(); }), 'Base cargada')} />
        {!name && <span className="muted small" style={{ marginLeft: 8 }}>Escribe un nombre para habilitar la carga</span>}
      </div>
      {loading ? <Loading /> : (data || []).map((d) => (
        <div className="list-item" key={d.id}>
          <div className="row between">
            <div><b>{d.name}</b> <span className="muted small">· {fmtNum(d.rowCount)} filas · {d.fileName}</span><div className="small muted">{d.purpose}</div></div>
            <div className="row" style={{ gap: 6 }}>
              <Check checked={d.enabled} onChange={(v) => run(() => patch(`/agents/${agentId}/datasets/${d.id}`, { enabled: v }).then(reload))} label="Habilitada" />
              <button className="btn sm" onClick={() => setEdit(JSON.parse(JSON.stringify(d)))}>Campos</button>
              <button className="btn sm" onClick={() => run(async () => setPreview(await post(`/agents/${agentId}/datasets/${d.id}/query`, { limit: 10 })))}>Vista previa</button>
              <button className="btn sm danger" onClick={() => confirm('¿Eliminar base?') && run(() => del(`/agents/${agentId}/datasets/${d.id}`).then(reload))}>Eliminar</button>
            </div>
          </div>
        </div>
      ))}
      {edit && (
        <Modal title={`Campos de ${edit.name}`} onClose={() => setEdit(null)} wide>
          <Field label="Propósito"><Text value={edit.purpose} onChange={(v) => setEdit({ ...edit, purpose: v })} /></Field>
          <table className="tbl"><thead><tr><th>Campo</th><th>Tipo</th><th>Descripción</th></tr></thead><tbody>
            {edit.columns.map((c: any, i: number) => (
              <tr key={c.name}>
                <td className="mono">{c.name}</td>
                <td><Select value={c.type} options={['string', 'number', 'date']} onChange={(v) => { const cols = [...edit.columns]; cols[i] = { ...c, type: v }; setEdit({ ...edit, columns: cols }); }} /></td>
                <td><Text value={c.description} onChange={(v) => { const cols = [...edit.columns]; cols[i] = { ...c, description: v }; setEdit({ ...edit, columns: cols }); }} /></td>
              </tr>
            ))}
          </tbody></table>
          <div className="row end" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy} onClick={() => run(() => patch(`/agents/${agentId}/datasets/${edit.id}`, { purpose: edit.purpose, columns: edit.columns }).then(() => { setEdit(null); reload(); }), 'Campos guardados')}>Guardar</button>
          </div>
        </Modal>
      )}
      {preview && (
        <Modal title={`${preview.dataset} · ${fmtNum(preview.total)} filas`} onClose={() => setPreview(null)} wide>
          <div className="tbl-wrap"><table className="tbl"><thead><tr>{Object.keys(preview.rows[0] || {}).map((k) => <th key={k}>{k}</th>)}</tr></thead>
            <tbody>{preview.rows.map((r: any, i: number) => <tr key={i}>{Object.values(r).map((v: any, j) => <td key={j}>{String(v)}</td>)}</tr>)}</tbody></table></div>
        </Modal>
      )}
    </>
  );
}

/* ------------------------------ Medios ------------------------------ */
export function MediaTab({ agentId }: { agentId: string }) {
  const { data, loading, reload } = useAsync(() => get<any[]>(`/agents/${agentId}/media`), [agentId]);
  const { busy, run } = useAction();
  const [form, setForm] = useState({ name: '', description: '', tags: '', expiresAt: '' });
  const [edit, setEdit] = useState<any>(null);

  return (
    <>
      <div className="card">
        <h2>Librería de archivos e imágenes</h2>
        <p className="hint">Recursos que el agente puede mostrar. La descripción relaciona el recurso con lo que pide el usuario; si la dejas vacía, Claude la genera analizando la imagen.</p>
        <div className="grid4">
          <Field label="Nombre"><Text value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="Modelo X - frontal rojo" /></Field>
          <Field label="Descripción"><Text value={form.description} onChange={(v) => setForm({ ...form, description: v })} placeholder="(automática si se omite)" /></Field>
          <Field label="Etiquetas (coma)"><Text value={form.tags} onChange={(v) => setForm({ ...form, tags: v })} placeholder="modelo x, rojo, exterior" /></Field>
          <Field label="Vigencia (opcional)"><input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></Field>
        </div>
        <FilePick label={busy ? 'Subiendo…' : 'Subir archivo'} disabled={busy} accept="image/*,.pdf" onPick={(f) => run(() => upload(`/agents/${agentId}/media`, f, form).then(() => { setForm({ name: '', description: '', tags: '', expiresAt: '' }); reload(); }), 'Recurso agregado')} />
      </div>
      {loading ? <Loading /> : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th></th><th>Recurso</th><th>Descripción</th><th>Vigencia</th><th>Habilitado</th><th></th></tr></thead>
            <tbody>
              {(data || []).map((m) => {
                const expired = m.expiresAt && new Date(m.expiresAt) < new Date();
                return (
                  <tr key={m.id}>
                    <td>{m.mimeType?.startsWith('image/') ? <img className="thumb" src={m.url} alt="" /> : <span className="badge">{m.mimeType?.split('/')[1]}</span>}</td>
                    <td><b>{m.name}</b><div className="small muted">{(m.tags || []).join(', ')}</div></td>
                    <td className="small" style={{ maxWidth: 380 }}>{m.description}</td>
                    <td className="small">{m.expiresAt ? <span className={`badge ${expired ? 'err' : ''}`}>{new Date(m.expiresAt).toLocaleDateString('es-MX')}</span> : '—'}</td>
                    <td><Check checked={m.enabled} onChange={(v) => run(() => patch(`/agents/${agentId}/media/${m.id}`, { enabled: v }).then(reload))} label="" /></td>
                    <td className="row" style={{ gap: 6 }}>
                      <button className="btn sm" onClick={() => setEdit({ ...m, tags: (m.tags || []).join(', '), expiresAt: m.expiresAt?.slice(0, 10) || '' })}>Editar</button>
                      <button className="btn sm danger" onClick={() => confirm('¿Eliminar recurso?') && run(() => del(`/agents/${agentId}/media/${m.id}`).then(reload))}>Eliminar</button>
                    </td>
                  </tr>
                );
              })}
              {!data?.length && <tr><td colSpan={6} className="empty">Sin recursos.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <Modal title="Editar recurso" onClose={() => setEdit(null)}>
          <Field label="Nombre"><Text value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} /></Field>
          <Field label="Descripción"><Area value={edit.description} onChange={(v) => setEdit({ ...edit, description: v })} /></Field>
          <Field label="Etiquetas"><Text value={edit.tags} onChange={(v) => setEdit({ ...edit, tags: v })} /></Field>
          <Field label="Vigencia"><input type="date" value={edit.expiresAt} onChange={(e) => setEdit({ ...edit, expiresAt: e.target.value })} /></Field>
          <div className="row end">
            <button className="btn primary" onClick={() => run(() => patch(`/agents/${agentId}/media/${edit.id}`, { name: edit.name, description: edit.description, tags: edit.tags.split(',').map((t: string) => t.trim()).filter(Boolean), expiresAt: edit.expiresAt || null }).then(() => { setEdit(null); reload(); }), 'Guardado')}>Guardar</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ------------------------------ Sitios web ------------------------------ */
export function WebTab({ agent, set }: { agent: any; set: (p: string, v: any) => void }) {
  const id = agent.id;
  const { data, loading, reload } = useAsync(() => get<any[]>(`/agents/${id}/web-sources`), [id]);
  const { busy, run } = useAction();
  const [src, setSrc] = useState({ url: '', role: '', sitemapUrl: '', pathPrefix: '', maxPages: 50, urls: '' });
  const refs: any[] = agent.webReferences || [];

  return (
    <>
      <div className="card">
        <h2>Conocimiento de sitios web</h2>
        <p className="hint">Se leen el mapa de sitio (sitemap.xml) o los enlaces internos, y el contenido accesible se indexa. Algunas páginas limitan la lectura automática; esas aparecen como fallidas.</p>
        <div className="grid3">
          <Field label="URL del sitio"><Text value={src.url} onChange={(v) => setSrc({ ...src, url: v })} placeholder="https://www.marca.com.mx" /></Field>
          <Field label="Sitemap (opcional)"><Text value={src.sitemapUrl} onChange={(v) => setSrc({ ...src, sitemapUrl: v })} placeholder="https://…/sitemap.xml" /></Field>
          <Field label="Solo rutas que inicien con (opcional)"><Text value={src.pathPrefix} onChange={(v) => setSrc({ ...src, pathPrefix: v })} placeholder="/modelos" /></Field>
        </div>
        <div className="grid3">
          <Field label="Papel de la fuente"><Text value={src.role} onChange={(v) => setSrc({ ...src, role: v })} placeholder="Fichas de modelos y precios públicos" /></Field>
          <Field label="Máx. páginas"><Num value={src.maxPages} onChange={(v) => setSrc({ ...src, maxPages: v })} /></Field>
          <Field label="URLs específicas (una por línea, opcional)"><Area value={src.urls} onChange={(v) => setSrc({ ...src, urls: v })} /></Field>
        </div>
        <button className="btn primary" disabled={!src.url || busy} onClick={() => run(() => post(`/agents/${id}/web-sources`, { ...src, urls: src.urls.split('\n').map((s) => s.trim()).filter(Boolean) }).then(() => { setSrc({ url: '', role: '', sitemapUrl: '', pathPrefix: '', maxPages: 50, urls: '' }); reload(); }), 'Indexación iniciada')}>Indexar sitio</button>
        <div style={{ marginTop: 14 }}>
          {loading ? <Loading /> : (data || []).map((s) => (
            <div className="list-item" key={s.id}>
              <div className="row between">
                <div><b>{s.url}</b> <StatusBadge status={s.status} /><div className="small muted">{s.role} · {s.pagesIndexed ?? 0} de {s.pagesFound ?? '?'} páginas indexadas · {fmtDate(s.finishedAt || s.createdAt)}</div></div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm" onClick={() => run(() => post(`/agents/${id}/web-sources/${s.id}/recrawl`).then(reload), 'Reindexando')}>Reindexar</button>
                  <button className="btn sm danger" onClick={() => confirm('¿Eliminar el sitio y sus páginas indexadas?') && run(() => del(`/agents/${id}/web-sources/${s.id}`).then(reload))}>Eliminar</button>
                </div>
              </div>
              {s.failed?.length > 0 && (
                <details className="small" style={{ marginTop: 6 }}>
                  <summary>{s.failed.length} páginas no procesables</summary>
                  <ul>{s.failed.slice(0, 30).map((f: any) => <li key={f.url}>{f.url} — {f.error}</li>)}</ul>
                </details>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Referencias web manuales</h2>
        <p className="hint">Enlaces de menús, categorías o secciones clave que el agente puede ofrecer sin afirmar que leyó información no disponible (útil cuando un portal limita la lectura automática). Se guardan con “Guardar cambios”.</p>
        {refs.map((r, i) => (
          <div className="grid3" key={i} style={{ alignItems: 'end' }}>
            <Field label="Título"><Text value={r.title} onChange={(v) => set(`webReferences.${i}.title`, v)} /></Field>
            <Field label="URL"><Text value={r.url} onChange={(v) => set(`webReferences.${i}.url`, v)} /></Field>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}><Field label="Descripción"><Text value={r.description} onChange={(v) => set(`webReferences.${i}.description`, v)} /></Field></div>
              <button className="btn sm danger" style={{ marginBottom: 12 }} onClick={() => set('webReferences', refs.filter((_, j) => j !== i))}>✕</button>
            </div>
          </div>
        ))}
        <button className="btn sm" onClick={() => set('webReferences', [...refs, { title: '', url: '', description: '' }])}>+ Agregar referencia</button>
      </div>
    </>
  );
}
