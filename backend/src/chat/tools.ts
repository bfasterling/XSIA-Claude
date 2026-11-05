import { col, FieldValue } from '../lib/firestore.js';
import { fetchWithTimeout, readBody } from '../lib/http.js';
import { normalizePhone, renderTemplate, sha256, stringifyForModel, toolName } from '../lib/utils.js';
import { searchKnowledge } from '../rag/search.js';
import { queryDataset } from '../rag/datasets.js';
import { activeMedia, searchMedia } from '../rag/media.js';
import { findDealers } from './dealers.js';
import { postToReceiver, transferRecoveredLead } from '../recovery/crm.js';
import { suppress } from '../recovery/suppression.js';
import { recordStats } from './sessions.js';
import type { Agent, ExternalApi, ActionFlow, Session, Site, Channel } from '../types.js';
import type { RecoveryContext } from './prompt.js';

export interface ToolContext {
  agent: Agent;
  session: Session;
  site?: Site | null;
  channel: Channel;
  recovery?: RecoveryContext | null;
  /** salidas para la UI */
  media: Array<{ id: string; url: string; name: string; mimeType?: string }>;
  /** mensajes que se enviarán por separado después de la respuesta (p. ej. atención a clientes) */
  followUps: string[];
  emit: (ev: any) => void;
  sessionPatch: Record<string, any>;
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  run: (input: any, ctx: ToolContext) => Promise<any>;
}

const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object', properties, required });

function externalApiTool(api: ExternalApi): ToolDef {
  const properties: Record<string, any> = {};
  for (const p of api.params || []) properties[p.name] = { type: p.type || 'string', description: p.description };
  return {
    name: toolName('api', api.name),
    description: `[CONSULTA] ${api.description}`.slice(0, 1000),
    input_schema: obj(properties, (api.params || []).filter((p) => p.required).map((p) => p.name)),
    run: async (input) => {
      let url = api.url;
      const query = new URLSearchParams();
      const body: Record<string, any> = {};
      const headers: Record<string, string> = { Accept: 'application/json', ...(api.headers || {}) };
      for (const p of api.params || []) {
        const v = input[p.name] ?? p.default;
        if (v === undefined || v === '') continue;
        if (p.in === 'path') url = url.replace(`{${p.name}}`, encodeURIComponent(String(v)));
        else if (p.in === 'query') query.set(p.name, String(v));
        else if (p.in === 'header') headers[p.name] = String(v);
        else body[p.name] = v;
      }
      const qs = query.toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
      try {
        const res = await fetchWithTimeout(url, {
          method: api.method || 'GET',
          headers: { ...(api.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...headers },
          body: api.method !== 'GET' ? JSON.stringify(body) : undefined,
          timeoutMs: api.timeoutMs || 15000,
        });
        const data = await readBody(res);
        if (!res.ok) return { ok: false, status: res.status, error: 'El servicio respondió con error', data };
        return { ok: true, status: res.status, data };
      } catch (e: any) {
        return { ok: false, error: 'El servicio no respondió a tiempo o no está disponible' };
      }
    },
  };
}

function actionFlowTool(flow: ActionFlow): ToolDef {
  const properties: Record<string, any> = {};
  for (const v of flow.variables || []) properties[v.name] = { type: 'string', description: v.description + (v.default ? ` (por defecto: ${v.default})` : '') };
  return {
    name: toolName('flujo', flow.name),
    description: `[ACCIÓN DE NEGOCIO] ${flow.description}${flow.steps ? `\nPasos/condiciones: ${flow.steps}` : ''}\nEjecuta solo con datos completos y confirmación del usuario.`.slice(0, 1500),
    input_schema: obj(properties, (flow.variables || []).filter((v) => v.required && !v.default).map((v) => v.name)),
    run: async (input, ctx) => {
      const vars: Record<string, any> = {};
      for (const v of flow.variables || []) vars[v.name] = input[v.name] ?? v.default ?? '';
      const missing = (flow.variables || []).filter((v) => v.required && !vars[v.name]).map((v) => v.name);
      if (missing.length) return { accepted: false, stage: 'validation', missing, error: `Faltan datos: ${missing.join(', ')}` };

      // Idempotencia: no repetir el mismo flujo con los mismos datos en la sesión
      const key = `${flow.id}_${sha256(JSON.stringify(vars)).slice(0, 12)}`;
      const prev = ctx.session.flowRuns?.[key];
      if (prev?.status === 'accepted')
        return { accepted: true, duplicate: true, externalId: prev.externalId, message: 'Esta solicitud ya fue registrada; no se duplicó.' };

      const result = await postToReceiver({
        url: flow.url,
        method: flow.method,
        headers: flow.headers,
        payloadTemplate: flow.payloadTemplate,
        responseIdPath: flow.responseIdPath,
        vars: {
          ...vars,
          variables: vars,
          contact: ctx.session.contact || {},
          session: { id: ctx.session.id, channel: ctx.channel, origin: ctx.session.origin },
          attribution: flow.attribution || {},
          site: ctx.site ? { key: ctx.site.key, name: ctx.site.name, dealerCode: ctx.site.dealerCode } : {},
          agent: { id: ctx.agent.id, name: ctx.agent.name },
        },
        log: { kind: 'action_flow', agentId: ctx.agent.id, sessionId: ctx.session.id, flowId: flow.id },
      });
      const run = { status: result.accepted ? 'accepted' : 'rejected', externalId: result.externalId ?? undefined, at: new Date().toISOString() };
      ctx.session.flowRuns = { ...(ctx.session.flowRuns || {}), [key]: run as any };
      ctx.sessionPatch[`flowRuns.${key}`] = run;
      if (result.accepted && flow.isLeadCapture) {
        ctx.sessionPatch.leadCaptured = true;
        await recordStats(ctx.agent.id, { leads: 1, origin: ctx.session.origin, siteKey: ctx.session.siteKey, campaignId: ctx.session.campaignId });
      }
      return {
        ...result,
        confirmationMessage: result.accepted ? renderTemplate(flow.confirmationMessage || '', { ...vars, externalId: result.externalId }) : undefined,
      };
    },
  };
}

export function buildTools(ctx: ToolContext, opts: { hasDatasets: boolean; hasMedia: boolean; hasDocs: boolean }): ToolDef[] {
  const { agent, recovery } = ctx;
  const tools: ToolDef[] = [];

  if (opts.hasDocs)
    tools.push({
      name: 'buscar_conocimiento',
      description:
        'Busca en los documentos y sitios web del agente (catálogos, fichas técnicas, condiciones, FAQ). Úsala antes de responder preguntas que requieran datos documentales. Formula la consulta con el producto/modelo del contexto.',
      input_schema: obj({ consulta: { type: 'string', description: 'Consulta autocontenida en lenguaje natural' } }, ['consulta']),
      run: async (input) => {
        const hits = await searchKnowledge(agent, String(input.consulta || ''));
        if (!hits.length) return { resultados: [], nota: 'Sin información relevante en el conocimiento del agente.' };
        return {
          resultados: hits.map((h) => ({ fuente: h.title, url: h.url || undefined, relevancia: Number(h.score.toFixed(3)), texto: h.text })),
        };
      },
    });

  if (opts.hasDatasets)
    tools.push({
      name: 'consultar_base_datos',
      description: 'Consulta una base de datos estructurada (CSV) del agente aplicando filtros. Revisa los campos disponibles en "Conocimiento disponible".',
      input_schema: obj(
        {
          base_id: { type: 'string' },
          filtros: {
            type: 'array',
            items: obj(
              {
                campo: { type: 'string' },
                operador: { type: 'string', enum: ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte'] },
                valor: { type: ['string', 'number'] },
              },
              ['campo', 'operador', 'valor'],
            ),
          },
          campos: { type: 'array', items: { type: 'string' }, description: 'Campos a devolver (opcional)' },
          ordenar_por: { type: 'string' },
          orden: { type: 'string', enum: ['asc', 'desc'] },
          limite: { type: 'integer', description: 'Máximo 50' },
        },
        ['base_id'],
      ),
      run: async (input) =>
        queryDataset(
          agent.id,
          input.base_id,
          (input.filtros || []).map((f: any) => ({ field: f.campo, op: f.operador, value: f.valor })),
          Math.min(input.limite || 15, 50),
          input.campos,
          input.ordenar_por ? { field: input.ordenar_por, dir: input.orden || 'asc' } : undefined,
        ),
    });

  if (opts.hasMedia) {
    tools.push({
      name: 'buscar_imagenes',
      description: 'Busca imágenes/archivos en la librería del agente por producto, modelo, versión o tema. Devuelve candidatos con su descripción.',
      input_schema: obj({ consulta: { type: 'string' } }, ['consulta']),
      run: async (input) => ({ recursos: await searchMedia(agent.id, String(input.consulta || '')) }),
    });
    tools.push({
      name: 'mostrar_recursos',
      description:
        'Muestra al usuario imágenes o archivos de la librería (por id). Elige solo recursos coherentes con el producto/modelo de la conversación. Máximo 4.',
      input_schema: obj({ ids: { type: 'array', items: { type: 'string' }, maxItems: 4 } }, ['ids']),
      run: async (input, c) => {
        const all = await activeMedia(agent.id);
        const chosen = all.filter((m) => (input.ids || []).includes(m.id)).slice(0, 4);
        for (const m of chosen) {
          const item = { id: m.id, url: m.url, name: m.name, mimeType: m.mimeType };
          c.media.push(item);
          c.emit({ type: 'media', item });
        }
        return chosen.length
          ? { mostrados: chosen.map((m) => m.name), nota: 'Los recursos ya se muestran al usuario; no pegues las URLs.' }
          : { mostrados: [], error: 'Ningún id válido, vigente y habilitado' };
      },
    });
  }

  for (const api of (agent.externalApis || []).filter((a) => a.enabled && a.url).slice(0, 5)) tools.push(externalApiTool(api));
  for (const flow of (agent.actionFlows || []).filter((f) => f.enabled && f.url).slice(0, 4)) tools.push(actionFlowTool(flow));

  tools.push({
    name: 'registrar_datos_contacto',
    description: 'Guarda los datos que el usuario proporcionó (nombre, teléfono, correo, interés, código postal). Úsala en cuanto los comparta.',
    input_schema: obj({
      nombre: { type: 'string' },
      apellidos: { type: 'string' },
      telefono: { type: 'string' },
      correo: { type: 'string' },
      interes: { type: 'string', description: 'Producto/modelo/servicio de interés' },
      codigo_postal: { type: 'string' },
    }),
    run: async (input, c) => {
      const contact = { ...(c.session.contact || {}) };
      const errors: string[] = [];
      if (input.nombre) contact.name = String(input.nombre).trim();
      if (input.apellidos) contact.lastName = String(input.apellidos).trim();
      if (input.telefono) {
        const p = normalizePhone(input.telefono);
        if (p) contact.phone = p;
        else errors.push('Teléfono con formato inválido (se esperan 10 dígitos)');
      }
      if (input.correo) {
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.correo)) contact.email = String(input.correo).trim().toLowerCase();
        else errors.push('Correo con formato inválido');
      }
      if (input.interes) contact.interest = String(input.interes);
      if (input.codigo_postal) contact.postalCode = String(input.codigo_postal);
      c.session.contact = contact;
      c.sessionPatch.contact = contact;
      return { guardado: contact, errores: errors.length ? errors : undefined };
    },
  });

  if ((agent.dealers?.mode && agent.dealers.mode !== 'none') || recovery)
    tools.push({
      name: 'buscar_distribuidores',
      description:
        'Busca distribuidores/sucursales cercanos a la ubicación que indique el CLIENTE (CP o ciudad). Si el cliente dio una ubicación distinta a la del distribuidor original, usa la del cliente.',
      input_schema: obj({
        codigo_postal: { type: 'string' },
        ciudad: { type: 'string' },
        estado: { type: 'string' },
        marca: { type: 'string' },
        cantidad: { type: 'integer' },
      }),
      run: async (input) => {
        const exclude: string[] = [];
        if (recovery?.campaign.crm?.excludeOriginalDealer && recovery.lead.originalDealerId) exclude.push(recovery.lead.originalDealerId);
        if (!input.codigo_postal && !input.ciudad && !input.estado) {
          if (recovery?.lead.zip) input.codigo_postal = recovery.lead.zip;
          else return { ok: false, error: 'Se requiere código postal o ciudad del cliente' };
        }
        return findDealers(agent, {
          postalCode: input.codigo_postal,
          city: input.ciudad,
          state: input.estado,
          brand: input.marca || recovery?.lead.brand,
          count: input.cantidad || recovery?.campaign.crm?.dealerCount,
          excludeIds: exclude,
        });
      },
    });

  if (agent.chatManager?.enabled && agent.chatManager.webhookUrl)
    tools.push({
      name: 'transferir_a_asesor',
      description: `Transfiere la conversación a atención humana. ${agent.chatManager.instructions || 'Úsala cuando el usuario lo pida o el caso lo amerite.'}`,
      input_schema: obj({ motivo: { type: 'string' }, resumen: { type: 'string' } }, ['motivo', 'resumen']),
      run: async (input, c) => {
        const r = await postToReceiver({
          url: agent.chatManager.webhookUrl,
          headers: agent.chatManager.headers,
          vars: {
            sessionId: c.session.id,
            agent: { id: agent.id, name: agent.name },
            channel: c.channel,
            contact: c.session.contact,
            userPhone: c.session.userPhone,
            reason: input.motivo,
            summary: input.resumen,
          },
          log: { kind: 'handoff', agentId: agent.id, sessionId: c.session.id },
        });
        if (r.accepted) c.sessionPatch.handoff = true;
        return r;
      },
    });

  if (recovery) {
    const leadRef = col.leads(recovery.campaign.id).doc(recovery.lead.id);
    tools.push({
      name: 'confirmar_interes',
      description: 'Registra si el cliente confirmó (true) o no (false) que desea continuar con su interés previo.',
      input_schema: obj({ interesado: { type: 'boolean' }, nota: { type: 'string' } }, ['interesado']),
      run: async (input) => {
        const outcome = input.interesado ? 'INTERESTED' : 'NOT_INTERESTED';
        if (recovery.lead.outcome !== 'RECOVERED') {
          await leadRef.update({ outcome, interestNote: input.nota || null, outcomeAt: FieldValue.serverTimestamp() });
          recovery.lead.outcome = outcome as any;
        }
        return { ok: true, outcome: recovery.lead.outcome };
      },
    });
    tools.push({
      name: 'seleccionar_distribuidor_y_transferir',
      description:
        'Cuando el cliente eligió un distribuidor de la lista: registra la selección y crea la nueva oportunidad en el CRM. No la uses dos veces.',
      input_schema: obj({ distribuidor_id: { type: 'string' }, distribuidor_nombre: { type: 'string' } }, ['distribuidor_id', 'distribuidor_nombre']),
      run: async (input, c) => {
        const result = await transferRecoveredLead({
          campaign: recovery.campaign,
          lead: recovery.lead,
          agent,
          session: c.session,
          dealer: { id: String(input.distribuidor_id), name: String(input.distribuidor_nombre) },
        });
        if (result.accepted && !result.duplicate) {
          recovery.lead.outcome = 'RECOVERED';
          const crm = recovery.campaign.crm;
          const csMsg = renderTemplate(crm?.customerServiceMessage || '', {
            phone: crm?.customerServicePhone,
            email: crm?.customerServiceEmail,
            name: recovery.lead.firstName,
            dealer: input.distribuidor_nombre,
          });
          if (csMsg.trim()) c.followUps.push(csMsg);
        }
        return result;
      },
    });
    tools.push({
      name: 'registrar_no_contactar',
      description: 'El cliente pidió no recibir más mensajes: aplica la supresión de contacto.',
      input_schema: obj({ motivo: { type: 'string' } }),
      run: async (input) => {
        await suppress(recovery.lead.phone, input.motivo || 'Solicitud del cliente en conversación', `campaign:${recovery.campaign.id}`);
        await leadRef.update({ outcome: 'OPTOUT', doNotContact: true, eligible: false, ineligibleReason: 'OPTOUT', outcomeAt: FieldValue.serverTimestamp() });
        return { ok: true };
      },
    });
    tools.push({
      name: 'registrar_queja',
      description: 'Registra una queja expresada por el cliente.',
      input_schema: obj({ detalle: { type: 'string' } }, ['detalle']),
      run: async (input) => {
        await leadRef.update({
          complaint: { detail: input.detalle, at: FieldValue.serverTimestamp() },
          ...(recovery.lead.outcome !== 'RECOVERED' ? { outcome: 'COMPLAINT' } : {}),
        });
        return { ok: true };
      },
    });
    tools.push({
      name: 'cerrar_sin_interes',
      description: 'El cliente no desea continuar (o ya fue atendido). Marca el lead como no recuperado.',
      input_schema: obj({ motivo: { type: 'string' } }),
      run: async (input) => {
        if (recovery.lead.outcome === 'RECOVERED') return { ok: false, nota: 'El lead ya está recuperado' };
        await leadRef.update({ outcome: 'NOT_RECOVERED', closeReason: input.motivo || null, outcomeAt: FieldValue.serverTimestamp() });
        return { ok: true };
      },
    });
  }
  return tools;
}

/** Ejecuta una herramienta y devuelve el contenido del tool_result */
export async function runTool(tools: ToolDef[], name: string, input: any, ctx: ToolContext) {
  const t = tools.find((x) => x.name === name);
  if (!t) return { content: `Herramienta desconocida: ${name}`, isError: true };
  try {
    const out = await t.run(input || {}, ctx);
    return { content: stringifyForModel(out), isError: false, raw: out };
  } catch (e: any) {
    return { content: `Error al ejecutar ${name}: ${e?.message || e}`, isError: true };
  }
}
