import { useState } from 'react';
import { post } from '../../lib/api';
import { Area, Check, Field, KeyValue, Modal, Select, Text, useAction } from '../../components/ui';

const uid = () => Math.random().toString(36).slice(2, 10);

/* ------------------------- Servicios externos (máx. 5) ------------------------- */
export function ApisTab({ agent, set }: { agent: any; set: (p: string, v: any) => void }) {
  const apis: any[] = agent.externalApis || [];
  const [testing, setTesting] = useState<any>(null);
  const [input, setInput] = useState('{}');
  const [result, setResult] = useState<any>(null);
  const { busy, run } = useAction();

  return (
    <>
      <div className="card">
        <h2>Consultas a servicios externos</h2>
        <p className="hint">
          Hasta 5 por agente. Son herramientas de <b>consulta</b> (precios, inventario, financiamiento, ubicaciones): obtienen información, no registran leads. Claude decide cuándo
          llamarlas según la descripción y reúne los parámetros desde la conversación.
        </p>
        {apis.length < 5 && (
          <button className="btn" onClick={() => set('externalApis', [...apis, { id: 'api_' + uid(), name: '', description: '', url: '', method: 'GET', headers: {}, params: [], enabled: true, timeoutMs: 15000 }])}>
            + Agregar servicio ({apis.length}/5)
          </button>
        )}
      </div>
      {apis.map((a, i) => {
        const p = `externalApis.${i}`;
        return (
          <div className="card" key={a.id || i}>
            <div className="row between">
              <h3>{a.name || `Servicio ${i + 1}`}</h3>
              <div className="row">
                <Check checked={a.enabled} onChange={(v) => set(`${p}.enabled`, v)} label="Habilitado" />
                <button className="btn sm" onClick={() => { setTesting(a); setResult(null); setInput(JSON.stringify(Object.fromEntries((a.params || []).map((x: any) => [x.name, x.default || ''])), null, 2)); }}>Probar</button>
                <button className="btn sm danger" onClick={() => set('externalApis', apis.filter((_, j) => j !== i))}>Eliminar</button>
              </div>
            </div>
            <div className="grid3">
              <Field label="Nombre / identificador"><Text value={a.name} onChange={(v) => set(`${p}.name`, v)} placeholder="Precios por versión" /></Field>
              <Field label="Método"><Select value={a.method} onChange={(v) => set(`${p}.method`, v)} options={['GET', 'POST', 'PUT']} /></Field>
              <Field label="Tiempo máx. (ms)"><input type="number" value={a.timeoutMs || 15000} onChange={(e) => set(`${p}.timeoutMs`, Number(e.target.value))} /></Field>
            </div>
            <Field label="URL" help="Admite parámetros de ruta como {modelo}"><Text value={a.url} onChange={(v) => set(`${p}.url`, v)} placeholder="https://api.empresa.com/precios/{modelo}" /></Field>
            <Field label="Instrucciones: cuándo y para qué usarlo"><Area value={a.description} onChange={(v) => set(`${p}.description`, v)} placeholder="Úsalo cuando el usuario pregunte el precio de una versión específica…" /></Field>
            <Field label="Autorización / encabezados"><KeyValue value={a.headers} onChange={(v) => set(`${p}.headers`, v)} /></Field>
            <Field label="Parámetros">
              {(a.params || []).map((x: any, j: number) => (
                <div key={j} className="grid4" style={{ gridTemplateColumns: '1fr 110px 110px 2fr 90px 40px', alignItems: 'center', display: 'grid', gap: 8, marginBottom: 6 }}>
                  <Text value={x.name} onChange={(v) => set(`${p}.params.${j}.name`, v)} placeholder="nombre" />
                  <Select value={x.type} onChange={(v) => set(`${p}.params.${j}.type`, v)} options={['string', 'number', 'boolean']} />
                  <Select value={x.in} onChange={(v) => set(`${p}.params.${j}.in`, v)} options={[['query', 'query'], ['path', 'ruta'], ['body', 'cuerpo'], ['header', 'header']]} />
                  <Text value={x.description} onChange={(v) => set(`${p}.params.${j}.description`, v)} placeholder="descripción para Claude" />
                  <Check checked={x.required} onChange={(v) => set(`${p}.params.${j}.required`, v)} label="Req." />
                  <button className="btn sm ghost" onClick={() => set(`${p}.params`, a.params.filter((_: any, k: number) => k !== j))}>✕</button>
                </div>
              ))}
              <button className="btn sm" onClick={() => set(`${p}.params`, [...(a.params || []), { name: '', type: 'string', in: 'query', description: '', required: false }])}>+ Parámetro</button>
            </Field>
          </div>
        );
      })}
      {testing && (
        <Modal title={`Probar: ${testing.name}`} onClose={() => setTesting(null)} wide>
          <Field label="Parámetros (JSON)"><Area value={input} onChange={setInput} /></Field>
          <button className="btn primary" disabled={busy} onClick={() => run(async () => setResult(await post(`/agents/${agent.id}/test-api`, { api: testing, input: JSON.parse(input || '{}') })))}>Ejecutar</button>
          {result && <pre style={{ marginTop: 12 }}>{JSON.stringify(result, null, 2)}</pre>}
        </Modal>
      )}
    </>
  );
}

/* ------------------------- Flujos de acción (máx. 4) ------------------------- */
const SAMPLE_PAYLOAD = `{
  "nombre": "{{nombre}}",
  "telefono": "{{telefono}}",
  "correo": "{{correo}}",
  "vehiculo": "{{vehiculo}}",
  "origen": "{{attribution.source}}",
  "sitio": "{{site.key}}",
  "sesion": "{{session.id}}"
}`;

export function FlowsTab({ agent, set }: { agent: any; set: (p: string, v: any) => void }) {
  const flows: any[] = agent.actionFlows || [];
  return (
    <>
      <div className="card">
        <h2>Flujos de acción</h2>
        <p className="hint">
          Hasta 4 por agente. Un flujo <b>ejecuta</b> una operación de negocio (p. ej. alta de lead en el CRM) cuando se cumplen sus condiciones. Se registran las etapas
          preparada → enviada → respuesta → aceptada/rechazada, y el agente solo confirma éxito si el receptor lo aceptó. Se evita duplicar el mismo envío en una conversación.
        </p>
        {flows.length < 4 && (
          <button
            className="btn"
            onClick={() =>
              set('actionFlows', [
                ...flows,
                { id: 'flow_' + uid(), name: '', description: '', steps: '', variables: [], url: '', method: 'POST', headers: {}, payloadTemplate: SAMPLE_PAYLOAD, responseIdPath: '', confirmationMessage: '', attribution: { source: '', medium: '', campaign: '' }, isLeadCapture: true, enabled: true },
              ])
            }
          >
            + Agregar flujo ({flows.length}/4)
          </button>
        )}
      </div>
      {flows.map((f, i) => {
        const p = `actionFlows.${i}`;
        return (
          <div className="card" key={f.id || i}>
            <div className="row between">
              <h3>{f.name || `Flujo ${i + 1}`}</h3>
              <div className="row">
                <Check checked={f.isLeadCapture} onChange={(v) => set(`${p}.isLeadCapture`, v)} label="Cuenta como lead" />
                <Check checked={f.enabled} onChange={(v) => set(`${p}.enabled`, v)} label="Habilitado" />
                <button className="btn sm danger" onClick={() => set('actionFlows', flows.filter((_, j) => j !== i))}>Eliminar</button>
              </div>
            </div>
            <div className="grid2">
              <Field label="Nombre"><Text value={f.name} onChange={(v) => set(`${p}.name`, v)} placeholder="Enviar lead al CRM" /></Field>
              <Field label="Método"><Select value={f.method} onChange={(v) => set(`${p}.method`, v)} options={['POST', 'PUT']} /></Field>
            </div>
            <Field label="Descripción para el agente: cuándo usarlo"><Area value={f.description} onChange={(v) => set(`${p}.description`, v)} placeholder="Cuando el usuario confirme que desea ser contactado por un asesor y tengas nombre y teléfono." /></Field>
            <Field label="Pasos / condiciones"><Area value={f.steps} onChange={(v) => set(`${p}.steps`, v)} /></Field>
            <Field label="Variables a recopilar">
              {(f.variables || []).map((v: any, j: number) => (
                <div key={j} style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 80px 40px', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                  <Text value={v.name} onChange={(x) => set(`${p}.variables.${j}.name`, x)} placeholder="nombre" />
                  <Text value={v.description} onChange={(x) => set(`${p}.variables.${j}.description`, x)} placeholder="explicación" />
                  <Text value={v.default} onChange={(x) => set(`${p}.variables.${j}.default`, x)} placeholder="valor por defecto" />
                  <Check checked={v.required} onChange={(x) => set(`${p}.variables.${j}.required`, x)} label="Req." />
                  <button className="btn sm ghost" onClick={() => set(`${p}.variables`, f.variables.filter((_: any, k: number) => k !== j))}>✕</button>
                </div>
              ))}
              <button className="btn sm" onClick={() => set(`${p}.variables`, [...(f.variables || []), { name: '', description: '', required: true }])}>+ Variable</button>
            </Field>
            <Field label="URL del receptor externo"><Text value={f.url} onChange={(v) => set(`${p}.url`, v)} placeholder="https://crm.empresa.com/api/leads" /></Field>
            <Field label="Encabezados / autorización"><KeyValue value={f.headers} onChange={(v) => set(`${p}.headers`, v)} /></Field>
            <Field
              label="Estructura del envío (JSON con {{variables}})"
              help="Disponibles: {{variable}}, {{contact.name}}, {{contact.phone}}, {{session.id}}, {{attribution.source}}, {{site.key}}, {{site.dealerCode}}, {{agent.name}}"
            >
              <Area tall value={f.payloadTemplate} onChange={(v) => set(`${p}.payloadTemplate`, v)} style={{ fontFamily: 'monospace' }} />
            </Field>
            <div className="grid2">
              <Field label="Ruta del ID devuelto (evidencia de aceptación)" help="Ej. data.id o leadId. Si se define, sin ID no se considera aceptado."><Text value={f.responseIdPath} onChange={(v) => set(`${p}.responseIdPath`, v)} /></Field>
              <Field label="Mensaje de confirmación" help="Puedes usar {{externalId}} y variables"><Text value={f.confirmationMessage} onChange={(v) => set(`${p}.confirmationMessage`, v)} /></Field>
            </div>
            <div className="grid3">
              <Field label="Atribución: origen"><Text value={f.attribution?.source} onChange={(v) => set(`${p}.attribution.source`, v)} placeholder="XSIA Chat" /></Field>
              <Field label="Medio"><Text value={f.attribution?.medium} onChange={(v) => set(`${p}.attribution.medium`, v)} placeholder="chat-web" /></Field>
              <Field label="Campaña"><Text value={f.attribution?.campaign} onChange={(v) => set(`${p}.attribution.campaign`, v)} /></Field>
            </div>
          </div>
        );
      })}
    </>
  );
}
