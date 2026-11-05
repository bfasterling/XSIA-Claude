import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, patch } from '../../lib/api';
import { CAMPAIGN_STATUS_LABEL, LEAD_TYPE_LABEL } from '../../lib/format';
import { Area, Check, ErrorBox, Field, KeyValue, Loading, Num, Select, StatusBadge, Tabs, Text, setIn, useAction, useAsync } from '../../components/ui';
import { LeadsTab, ExecutionTab, ReportsTab } from './RecoveryTabs';

const TABS: Array<[string, string]> = [
  ['general', '1. General'],
  ['leads', '2. Leads'],
  ['agent', '3. Agente XSIA'],
  ['messages', '4. Mensajes'],
  ['promotions', '5. Promociones'],
  ['whatsapp', '6. WhatsApp'],
  ['rules', '7. Reglas'],
  ['crm', '8. CRM'],
  ['evaluation', '9. Evaluación'],
  ['execution', '10. Ejecución'],
  ['reports', '11. Reportes'],
];
const CONFIG = ['general', 'agent', 'messages', 'promotions', 'whatsapp', 'rules', 'crm', 'evaluation'];
const TYPES = ['NOT_CONTACTED', 'ABANDONED', 'REJECTED'];
const PARAM_FIELDS: Array<[string, string]> = [
  ['firstName', 'Nombre'], ['fullName', 'Nombre completo'], ['brand', 'Marca'], ['model', 'Modelo'], ['version', 'Versión'], ['year', 'Año'], ['vehicle', 'Vehículo (marca+modelo+versión)'], ['promotion', 'Promoción'], ['dealerName', 'Distribuidor original'],
];
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export default function CampaignEditor() {
  const { id = '', tab = 'general' } = useParams();
  const nav = useNavigate();
  const { data, error, loading, setData, reload } = useAsync(() => get(`/campaigns/${id}`), [id]);
  const agents = useAsync(() => get<any[]>('/agents'), []);
  const lines = useAsync(() => get<any[]>('/lines'), []);
  const [c, setC] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const { busy, run } = useAction();
  const [agentDetail, setAgentDetail] = useState<any>(null);

  useEffect(() => {
    if (data) {
      setC(data);
      setDirty(false);
    }
  }, [data]);
  useEffect(() => {
    if (c?.agentId) get(`/agents/${c.agentId}`).then(setAgentDetail).catch(() => setAgentDetail(null));
  }, [c?.agentId]);

  if (loading || !c) return error ? <ErrorBox error={error} /> : <Loading />;
  const set = (path: string, v: any) => {
    setC((x: any) => setIn(x, path, v));
    setDirty(true);
  };
  const save = () =>
    run(async () => {
      const body: any = {};
      for (const k of ['name', 'description', 'agentId', 'actionFlowId', 'agentInstructions', 'templates', 'secondAttemptTemplates', 'promotions', 'whatsapp', 'rules', 'crm', 'evaluation']) body[k] = c[k];
      setData(await patch(`/campaigns/${id}`, body));
    }, 'Campaña guardada');

  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted"><Link to="/admin/recovery">Recovery</Link> /</div>
          <h1>{c.name} <StatusBadge status={c.status} /></h1>
          <p>{CAMPAIGN_STATUS_LABEL[c.status]} · {c.description}</p>
        </div>
        {CONFIG.includes(tab) && <button className="btn primary" disabled={!dirty || busy} onClick={save}>{dirty ? 'Guardar cambios' : 'Guardado'}</button>}
      </div>
      <Tabs tabs={TABS} active={tab} onChange={(t) => nav(`/admin/recovery/${id}/${t}`)} />

      {tab === 'general' && (
        <div className="card">
          <h2>Información general</h2>
          <Field label="Nombre"><Text value={c.name} onChange={(v) => set('name', v)} /></Field>
          <Field label="Descripción" help="Propósito, periodo, unidad comercial o base de origen"><Area value={c.description} onChange={(v) => set('description', v)} /></Field>
        </div>
      )}

      {tab === 'leads' && <LeadsTab campaignId={id} campaign={c} />}

      {tab === 'agent' && (
        <div className="card">
          <h2>Agente XSIA</h2>
          <p className="hint">Asesor que atiende las respuestas de los contactos. Debe estar preparado para confirmar interés, aprovechar el historial y orientar por distribuidor.</p>
          <div className="grid2">
            <Field label="Agente"><Select value={c.agentId} onChange={(v) => set('agentId', v)} options={[['', '— Selecciona —'], ...((agents.data || []).map((a) => [a.id, a.name]) as any)]} /></Field>
            <Field label="Flujo de acción para conversión al CRM (opcional)" help="Si se elige y el modo CRM es “flujo de acción”, se usa este flujo del agente.">
              <Select value={c.actionFlowId} onChange={(v) => set('actionFlowId', v)} options={[['', '— Ninguno —'], ...((agentDetail?.actionFlows || []).map((f: any) => [f.id, `${f.name}${f.enabled ? '' : ' (deshabilitado)'}`]) as any)]} />
            </Field>
          </div>
          <Field label="Instrucciones específicas de la campaña para el agente" help="Cuándo activar la transferencia, tono, qué no ofrecer, etc.">
            <Area tall value={c.agentInstructions} onChange={(v) => set('agentInstructions', v)} />
          </Field>
        </div>
      )}

      {tab === 'messages' && (
        <>
          <div className="alert info">
            Usa el <b>nombre exacto</b> de la plantilla aprobada en tu cuenta de WhatsApp Business y su código de idioma (p. ej. es_MX). La cantidad y el orden de los parámetros deben coincidir con
            la plantilla autorizada. Una plantilla “en revisión” no está lista para producción.
          </div>
          {TYPES.map((t) => {
            const T = c.templates[t];
            const p = `templates.${t}`;
            return (
              <div className="card" key={t}>
                <div className="row between"><h2>{LEAD_TYPE_LABEL[t]}</h2><Check checked={T.enabled !== false} onChange={(v) => set(`${p}.enabled`, v)} label="Habilitada" /></div>
                <div className="grid3">
                  <Field label="Nombre de la plantilla"><Text value={T.name} onChange={(v) => set(`${p}.name`, v)} placeholder="reactivacion_abandonado_v2" /></Field>
                  <Field label="Idioma"><Text value={T.language} onChange={(v) => set(`${p}.language`, v)} placeholder="es_MX" /></Field>
                  <Field label="Imagen de encabezado (URL, si la plantilla la usa)"><Text value={T.headerImageUrl} onChange={(v) => set(`${p}.headerImageUrl`, v)} /></Field>
                </div>
                <Field label="Parámetros del cuerpo, en orden ({{1}}, {{2}}, …)">
                  <div className="row">
                    {(T.params || []).map((x: string, i: number) => (
                      <div key={i} className="row" style={{ gap: 4 }}>
                        <span className="badge">{`{{${i + 1}}}`}</span>
                        <Select value={x} onChange={(v) => set(`${p}.params.${i}`, v)} options={PARAM_FIELDS} />
                        <button className="btn sm ghost" onClick={() => set(`${p}.params`, T.params.filter((_: any, j: number) => j !== i))}>✕</button>
                      </div>
                    ))}
                    <button className="btn sm" onClick={() => set(`${p}.params`, [...(T.params || []), 'firstName'])}>+ Parámetro</button>
                  </div>
                </Field>
                <Field label="Texto de la plantilla (referencia)" help="Copia el texto aprobado con {{1}}, {{2}}… Se usa como contexto del agente y en reportes."><Area value={T.previewText} onChange={(v) => set(`${p}.previewText`, v)} /></Field>
                <Field label="Contexto del mensaje inicial para el agente" help="Qué se ofreció y cuál es la intención comercial, para que el asesor no repita el texto."><Area value={T.context} onChange={(v) => set(`${p}.context`, v)} /></Field>
                <div className="grid2">
                  <Field label="Origen comercial para el CRM"><Text value={T.crmOrigin} onChange={(v) => set(`${p}.crmOrigin`, v)} /></Field>
                  <Field label="Descripción de procedencia"><Text value={T.originDescription} onChange={(v) => set(`${p}.originDescription`, v)} placeholder="Campaña de Reasignación - Abandonado" /></Field>
                </div>
                <details>
                  <summary className="small">Plantilla para segundo intento (opcional)</summary>
                  <div className="grid2" style={{ marginTop: 8 }}>
                    <Field label="Nombre"><Text value={c.secondAttemptTemplates?.[t]?.name} onChange={(v) => set(`secondAttemptTemplates.${t}`, { ...T, ...(c.secondAttemptTemplates?.[t] || {}), name: v })} /></Field>
                    <Field label="Idioma"><Text value={c.secondAttemptTemplates?.[t]?.language} onChange={(v) => set(`secondAttemptTemplates.${t}`, { ...T, ...(c.secondAttemptTemplates?.[t] || {}), language: v })} /></Field>
                  </div>
                </details>
              </div>
            );
          })}
          <div className="card">
            <h2>Mensaje final de atención a clientes</h2>
            <p className="hint">Se envía como mensaje separado después de la confirmación comercial. Variables: {'{{name}}, {{dealer}}, {{phone}}, {{email}}'}.</p>
            <Field label="Mensaje"><Area value={c.crm.customerServiceMessage} onChange={(v) => set('crm.customerServiceMessage', v)} placeholder="Si necesitas ayuda adicional, comunícate a Atención a Clientes al {{phone}} o escribe a {{email}}." /></Field>
            <div className="grid2">
              <Field label="Teléfono de atención"><Text value={c.crm.customerServicePhone} onChange={(v) => set('crm.customerServicePhone', v)} /></Field>
              <Field label="Correo de atención"><Text value={c.crm.customerServiceEmail} onChange={(v) => set('crm.customerServiceEmail', v)} /></Field>
            </div>
          </div>
        </>
      )}

      {tab === 'promotions' && (
        <div className="card">
          <h2>Promociones por vehículo</h2>
          <p className="hint">Se aplica la regla más específica que coincida con marca/modelo/versión/año del lead (campos vacíos = cualquiera). Si no hay coincidencia se usa el texto predeterminado.</p>
          {(c.promotions.rules || []).map((r: any, i: number) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 90px 3fr 40px', gap: 8, marginBottom: 6 }}>
              {['brand', 'model', 'version', 'year'].map((k) => <Text key={k} value={r[k]} placeholder={{ brand: 'Marca', model: 'Modelo', version: 'Versión', year: 'Año' }[k]} onChange={(v) => set(`promotions.rules.${i}.${k}`, v)} />)}
              <Text value={r.text} placeholder="Texto de la promoción" onChange={(v) => set(`promotions.rules.${i}.text`, v)} />
              <button className="btn sm ghost" onClick={() => set('promotions.rules', c.promotions.rules.filter((_: any, j: number) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="btn sm" onClick={() => set('promotions.rules', [...(c.promotions.rules || []), { brand: '', model: '', version: '', year: '', text: '' }])}>+ Regla</button>
          <Field label="Texto predeterminado"><Text value={c.promotions.defaultText} onChange={(v) => set('promotions.defaultText', v)} /></Field>
          <div className="alert warn">Las promociones deben mantenerse vigentes y autorizadas por los responsables del negocio.</div>
        </div>
      )}

      {tab === 'whatsapp' && (
        <>
          <div className="card">
            <h2>Líneas participantes</h2>
            <p className="hint">Solo las líneas habilitadas se usan para enviar; una línea deshabilitada no bloquea el lanzamiento.</p>
            {(lines.data || []).map((l) => (
              <div key={l.id} className="row" style={{ marginBottom: 6 }}>
                <Check checked={c.whatsapp.lineIds.includes(l.id)} onChange={(v) => set('whatsapp.lineIds', v ? [...c.whatsapp.lineIds, l.id] : c.whatsapp.lineIds.filter((x: string) => x !== l.id))} label={<span>{l.name} <span className="muted small">{l.displayPhone}</span></span>} />
                {l.enabled ? <span className="badge ok">habilitada</span> : <span className="badge err">deshabilitada</span>}
                <span className="small muted">Límite {l.dailyLimit}/día · usados hoy {l.usedToday}</span>
                {c.whatsapp.strategy === 'weighted' && c.whatsapp.lineIds.includes(l.id) && (
                  <span className="row small">Peso <input type="number" style={{ width: 70 }} value={c.whatsapp.weights?.[l.id] ?? 1} onChange={(e) => set(`whatsapp.weights.${l.id}`, Number(e.target.value))} /></span>
                )}
              </div>
            ))}
            <div className="grid2" style={{ marginTop: 10 }}>
              <Field label="Distribución del tráfico"><Select value={c.whatsapp.strategy} onChange={(v) => set('whatsapp.strategy', v)} options={[['balanced', 'Balanceada'], ['weighted', 'Ponderada'], ['specific', 'Línea específica']]} /></Field>
              {c.whatsapp.strategy === 'specific' && (
                <Field label="Línea específica"><Select value={c.whatsapp.specificLineId} onChange={(v) => set('whatsapp.specificLineId', v)} options={[['', '—'], ...((lines.data || []).filter((l) => c.whatsapp.lineIds.includes(l.id)).map((l) => [l.id, l.name]) as any)]} /></Field>
              )}
            </div>
          </div>
          <div className="card">
            <h2>Ventana y calendario de envío</h2>
            <div className="grid4">
              <Field label="Hora de inicio"><Num min={0} max={23} value={c.whatsapp.window.startHour} onChange={(v) => set('whatsapp.window.startHour', v)} /></Field>
              <Field label="Hora de término"><Num min={1} max={24} value={c.whatsapp.window.endHour} onChange={(v) => set('whatsapp.window.endHour', v)} /></Field>
              <Field label="Máx. leads por hora"><Num value={c.whatsapp.maxPerHour} onChange={(v) => set('whatsapp.maxPerHour', v)} /></Field>
              <Field label="Máx. envíos concurrentes"><Num value={c.whatsapp.maxConcurrent} onChange={(v) => set('whatsapp.maxConcurrent', v)} /></Field>
            </div>
            <Field label="Días habilitados">
              <div className="row">{DAYS.map((d, i) => <Check key={i} label={d} checked={c.whatsapp.window.days.includes(i)} onChange={(v) => set('whatsapp.window.days', v ? [...c.whatsapp.window.days, i].sort() : c.whatsapp.window.days.filter((x: number) => x !== i))} />)}</div>
            </Field>
            <Field label="Zona horaria"><Text value={c.whatsapp.window.timezone} onChange={(v) => set('whatsapp.window.timezone', v)} /></Field>
            <div className="small muted">Las respuestas que lleguen fuera de la ventana se atienden normalmente; la ventana solo limita los envíos iniciales.</div>
          </div>
        </>
      )}

      {tab === 'rules' && (
        <div className="card">
          <h2>Reglas de espera y segundo intento</h2>
          <div className="grid3">
            <Field label="Horas sin respuesta"><Num value={c.rules.noResponseHours} onChange={(v) => set('rules.noResponseHours', v)} /></Field>
            <Field label="Al vencer el plazo"><Check checked={c.rules.markNoResponse} onChange={(v) => set('rules.markNoResponse', v)} label="Marcar “Sin respuesta”" /></Field>
            <Field label="Segundo intento"><Check checked={c.rules.secondAttempt} onChange={(v) => set('rules.secondAttempt', v)} label="Permitir segundo intento" /></Field>
          </div>
          {c.rules.secondAttempt && <Field label="Esperar antes del segundo intento (horas)"><Num value={c.rules.secondAttemptDelayHours} onChange={(v) => set('rules.secondAttemptDelayHours', v)} /></Field>}
          <div className="alert warn">El segundo intento nunca se envía a contactos bloqueados, con opt-out o que hayan rechazado expresamente.</div>
        </div>
      )}

      {tab === 'crm' && (
        <div className="card">
          <h2>Destino comercial (CRM)</h2>
          <div className="grid3">
            <Field label="Mecanismo"><Select value={c.crm.mode} onChange={(v) => set('crm.mode', v)} options={[['webhook', 'Webhook directo'], ['action_flow', 'Flujo de acción del agente'], ['none', 'Sin transferencia']]} /></Field>
            <Field label="Distribuidores a ofrecer"><Num value={c.crm.dealerCount} onChange={(v) => set('crm.dealerCount', v)} /></Field>
            <Field label="Búsqueda de alternativas"><Check checked={c.crm.excludeOriginalDealer} onChange={(v) => set('crm.excludeOriginalDealer', v)} label="Excluir distribuidor original" /></Field>
          </div>
          {c.crm.mode === 'webhook' && (
            <>
              <div className="grid2">
                <Field label="URL del CRM"><Text value={c.crm.url} onChange={(v) => set('crm.url', v)} /></Field>
                <Field label="Ruta del ID devuelto" help="Ej. leadId o data.id (evidencia de recepción)"><Text value={c.crm.responseIdPath} onChange={(v) => set('crm.responseIdPath', v)} /></Field>
              </div>
              <Field label="Encabezados"><KeyValue value={c.crm.headers} onChange={(v) => set('crm.headers', v)} /></Field>
              <Field
                label="Estructura del envío (JSON)"
                help="Variables: {{lead.firstName}} {{lead.lastName}} {{lead.fullName}} {{lead.phone}} {{lead.email}} {{lead.brand}} {{lead.model}} {{lead.version}} {{lead.year}} {{lead.sourceId}} {{lead.type}} {{lead.originalDealerId}} {{dealer.id}} {{dealer.name}} {{origin}} {{originDescription}} {{campaign.id}} {{campaign.name}} {{session.id}}"
              >
                <Area tall style={{ fontFamily: 'monospace' }} value={c.crm.payloadTemplate} onChange={(v) => set('crm.payloadTemplate', v)} placeholder={'{\n  "firstName": "{{lead.firstName}}",\n  "phone": "{{lead.phone}}",\n  "dealerCode": "{{dealer.id}}",\n  "source": "{{origin}}",\n  "comments": "{{originDescription}}"\n}'} />
              </Field>
            </>
          )}
          {c.crm.mode === 'action_flow' && <div className="alert info">Se usará el flujo seleccionado en la pestaña “Agente XSIA”.</div>}
        </div>
      )}

      {tab === 'evaluation' && (
        <div className="card">
          <h2>Evaluación conversacional</h2>
          <p className="hint">Claude analiza cada conversación respondida. Son señales para los reportes; no sustituyen la confirmación explícita del cliente.</p>
          {[['mood', 'Mood / ánimo (incluye detección de enojo)'], ['purchaseIntent', 'Intención de compra'], ['recoveryProbability', 'Probabilidad de recuperación'], ['complaint', 'Detección de queja'], ['optOut', 'Detección de no contactar (aplica supresión)']].map(([k, l]) => (
            <div key={k} style={{ marginBottom: 8 }}><Check checked={c.evaluation[k]} onChange={(v) => set(`evaluation.${k}`, v)} label={l} /></div>
          ))}
        </div>
      )}

      {tab === 'execution' && <ExecutionTab campaignId={id} campaign={c} onChange={reload} />}
      {tab === 'reports' && <ReportsTab campaignId={id} campaign={c} />}
    </>
  );
}
