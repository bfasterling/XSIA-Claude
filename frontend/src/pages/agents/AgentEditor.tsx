import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, patch } from '../../lib/api';
import { Area, Check, ErrorBox, Field, Loading, Num, Select, Tabs, Text, setIn, useAction, useAsync } from '../../components/ui';
import { DocumentsTab, DatasetsTab, MediaTab, WebTab } from './KnowledgeTabs';
import { ApisTab, FlowsTab } from './ToolsTabs';
import { DistributionTab, ChannelsTab } from './DistributionTabs';
import { SessionsTab, DashboardTab } from './DataTabs';

const TABS: Array<[string, string]> = [
  ['general', 'General'],
  ['instructions', 'Instrucciones'],
  ['leads', 'Cualificación'],
  ['documents', 'Documentos'],
  ['datasets', 'Datos CSV'],
  ['media', 'Archivos e imágenes'],
  ['web', 'Sitios web'],
  ['apis', 'Servicios externos'],
  ['flows', 'Flujos de acción'],
  ['distribution', 'Distribución'],
  ['channels', 'Canales y voz'],
  ['data', 'Data'],
  ['dashboard', 'Dashboard'],
];
/** Pestañas que editan el documento del agente (usan el botón Guardar) */
const CONFIG_TABS = ['general', 'instructions', 'leads', 'web', 'apis', 'flows', 'distribution', 'channels', 'documents'];

export default function AgentEditor() {
  const { id = '', tab = 'general' } = useParams();
  const nav = useNavigate();
  const { data, error, loading, setData } = useAsync(() => get(`/agents/${id}`), [id]);
  const [agent, setAgent] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const { busy, run } = useAction();

  useEffect(() => {
    if (data) {
      setAgent(data);
      setDirty(false);
    }
  }, [data]);

  if (loading || !agent) return error ? <ErrorBox error={error} /> : <Loading />;
  const set = (path: string, v: any) => {
    setAgent((a: any) => setIn(a, path, v));
    setDirty(true);
  };
  const save = () =>
    run(async () => {
      const { id: _i, createdAt, updatedAt, ...body } = agent;
      const r = await patch(`/agents/${id}`, body);
      setData(r);
    }, 'Configuración guardada');

  const A = agent;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted"><Link to="/admin/agents">Agentes</Link> /</div>
          <h1>{A.name}</h1>
          <p>Acceso directo: <a href={`/c/${A.slug}`} target="_blank" rel="noreferrer">/c/{A.slug}</a></p>
        </div>
        <div className="row">
          <a className="btn" href={`/c/${A.slug}`} target="_blank" rel="noreferrer">Probar chat ↗</a>
          {CONFIG_TABS.includes(tab) && (
            <button className="btn primary" disabled={!dirty || busy} onClick={save}>{busy ? 'Guardando…' : dirty ? 'Guardar cambios' : 'Guardado'}</button>
          )}
        </div>
      </div>
      <Tabs tabs={TABS} active={tab} onChange={(t) => nav(`/admin/agents/${id}/${t}`)} />

      {tab === 'general' && (
        <div className="card">
          <h2>Identidad y modelo</h2>
          <div className="grid2">
            <Field label="Nombre"><Text value={A.name} onChange={(v) => set('name', v)} /></Field>
            <Field label="Identificador de acceso (slug)" help="Define la URL /c/identificador"><Text value={A.slug} onChange={(v) => set('slug', v)} /></Field>
          </div>
          <Field label="Descripción / propósito"><Area value={A.description} onChange={(v) => set('description', v)} /></Field>
          <div className="grid4">
            <Field label="Estado"><Select value={A.status} onChange={(v) => set('status', v)} options={[['active', 'Activo'], ['inactive', 'Inactivo']]} /></Field>
            <Field label="Modelo Claude (chat)" help="Vacío = predeterminado del sistema"><Text value={A.model?.chat} onChange={(v) => set('model.chat', v)} placeholder="claude-sonnet-5-5" /></Field>
            <Field label="Temperatura"><Num step="0.1" min="0" max="1" value={A.model?.temperature} onChange={(v) => set('model.temperature', v)} /></Field>
            <Field label="Máx. tokens de respuesta"><Num value={A.model?.maxTokens} onChange={(v) => set('model.maxTokens', v)} /></Field>
          </div>
        </div>
      )}

      {tab === 'instructions' && (
        <>
          <div className="card">
            <h2>Instrucciones principales y específicas</h2>
            <p className="hint">Definen identidad, principios, límites, marca, catálogo, argumentos comerciales y objetivos de conversión.</p>
            <Field label="Instrucción principal" help="Identidad, principios generales, límites de actuación y criterios generales."><Area tall value={A.instructions.main} onChange={(v) => set('instructions.main', v)} /></Field>
            <Field label="Instrucción específica del agente" help="Marca, catálogo, argumentos, lenguaje, restricciones, reglas de contacto y objetivos."><Area tall value={A.instructions.specific} onChange={(v) => set('instructions.specific', v)} /></Field>
            <Field label="Estilo de respuesta" help="Extensión, tono, persona gramatical, prioridad técnica/comercial."><Area value={A.instructions.responseStyle} onChange={(v) => set('instructions.responseStyle', v)} /></Field>
          </div>
          <div className="card">
            <h2>Etapas de conversación</h2>
            <Field label="Mensaje de bienvenida (se muestra al abrir el chat)"><Area value={A.instructions.welcomeMessage} onChange={(v) => set('instructions.welcomeMessage', v)} /></Field>
            <div className="grid3">
              <Field label="Inicio"><Area tall value={A.instructions.stageStart} onChange={(v) => set('instructions.stageStart', v)} /></Field>
              <Field label="Conversación"><Area tall value={A.instructions.stageConversation} onChange={(v) => set('instructions.stageConversation', v)} /></Field>
              <Field label="Finalización / cierre"><Area tall value={A.instructions.stageClosing} onChange={(v) => set('instructions.stageClosing', v)} /></Field>
            </div>
          </div>
          <div className="card">
            <h2>Criterios de herramientas y CTA</h2>
            <div className="grid2">
              <Field label="Criterios de herramientas" help="Cuándo consultar información externa o ejecutar una acción."><Area tall value={A.instructions.toolsCriteria} onChange={(v) => set('instructions.toolsCriteria', v)} /></Field>
              <Field label="Criterios de CTA" help="Cuándo sugerir opciones y cómo redactarlas."><Area tall value={A.instructions.ctaCriteria} onChange={(v) => set('instructions.ctaCriteria', v)} /></Field>
            </div>
          </div>
        </>
      )}

      {tab === 'leads' && (
        <div className="card">
          <h2>Cualificación de leads</h2>
          <p className="hint">Cómo reconocer y registrar oportunidades. El registro efectivo lo hace un flujo de acción marcado como “captura de lead”.</p>
          <Check checked={A.leadQualification.enabled} onChange={(v) => set('leadQualification.enabled', v)} label="Habilitar cualificación de leads" />
          <div className="grid2" style={{ marginTop: 12 }}>
            <Field label="Datos requeridos">
              <div className="row">
                {[['name', 'Nombre'], ['phone', 'Teléfono'], ['email', 'Correo'], ['interest', 'Producto de interés']].map(([k, l]) => (
                  <Check key={k} label={l} checked={A.leadQualification.requiredFields.includes(k)} onChange={(c) => set('leadQualification.requiredFields', c ? [...A.leadQualification.requiredFields, k] : A.leadQualification.requiredFields.filter((x: string) => x !== k))} />
                ))}
              </div>
            </Field>
            <Field label="Regla de contacto">
              <Select value={A.leadQualification.contactRule} onChange={(v) => set('leadQualification.contactRule', v)} options={[['phone', 'Teléfono'], ['email', 'Correo'], ['phone_or_email', 'Teléfono o correo'], ['phone_and_email', 'Teléfono y correo']]} />
            </Field>
          </div>
          <Field label="Señales de interés"><Area value={A.leadQualification.signals} onChange={(v) => set('leadQualification.signals', v)} placeholder="Solicitud de cotización, asesor, prueba de manejo, confirmación explícita para continuar…" /></Field>
          <Field label="Reglas adicionales"><Area value={A.leadQualification.rules} onChange={(v) => set('leadQualification.rules', v)} /></Field>
        </div>
      )}

      {tab === 'documents' && <DocumentsTab agent={A} set={set} />}
      {tab === 'datasets' && <DatasetsTab agentId={id} />}
      {tab === 'media' && <MediaTab agentId={id} />}
      {tab === 'web' && <WebTab agent={A} set={set} />}
      {tab === 'apis' && <ApisTab agent={A} set={set} />}
      {tab === 'flows' && <FlowsTab agent={A} set={set} />}
      {tab === 'distribution' && <DistributionTab agent={A} set={set} />}
      {tab === 'channels' && <ChannelsTab agent={A} set={set} />}
      {tab === 'data' && <SessionsTab agentId={id} />}
      {tab === 'dashboard' && <DashboardTab agentId={id} />}
    </>
  );
}
