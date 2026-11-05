import { col } from '../lib/firestore.js';
import { activeMedia } from '../rag/media.js';
import { config } from '../config.js';
import type { Agent, Campaign, Channel, Lead, Session, Site } from '../types.js';

const TYPE_LABEL: Record<string, string> = {
  NOT_CONTACTED: 'No contactado / no atendido',
  ABANDONED: 'Abandonado',
  REJECTED: 'Rechazado',
};

export interface RecoveryContext {
  campaign: Campaign;
  lead: Lead;
  templateText?: string;
}

const knowledgeCache = new Map<string, { at: number; text: string }>();

/** Resumen del conocimiento disponible (documentos, bases CSV, referencias, medios) */
async function knowledgeSummary(agent: Agent): Promise<string> {
  const hit = knowledgeCache.get(agent.id);
  if (hit && Date.now() - hit.at < 60_000) return hit.text;
  const [docs, datasets, media] = await Promise.all([
    col.documents(agent.id).where('status', '==', 'ready').select('name', 'title', 'instructions', 'sourceType', 'url').limit(200).get(),
    col.datasets(agent.id).where('enabled', '==', true).get(),
    activeMedia(agent.id),
  ]);
  const parts: string[] = [];
  const files = docs.docs.filter((d) => d.get('sourceType') !== 'web');
  const webCount = docs.size - files.length;
  if (files.length) {
    parts.push(
      '## Documentos de referencia (usa la herramienta buscar_conocimiento)\n' +
        files
          .map((d) => `- ${d.get('title') || d.get('name')}${d.get('instructions') ? ` — Uso: ${d.get('instructions')}` : ''}`)
          .join('\n'),
    );
  }
  if (webCount) parts.push(`## Sitios web indexados\n${webCount} páginas indexadas, consultables con buscar_conocimiento.`);
  if (datasets.size) {
    parts.push(
      '## Bases de datos estructuradas (usa consultar_base_datos)\n' +
        datasets.docs
          .map((d) => {
            const x: any = d.data();
            return `- base_id="${d.id}" · ${x.name}: ${x.purpose || ''}\n  Campos: ${(x.columns || [])
              .map((c: any) => `${c.name} (${c.type}${c.description ? ': ' + c.description : ''})`)
              .join('; ')}`;
          })
          .join('\n'),
    );
  }
  if (agent.webReferences?.length) {
    parts.push(
      '## Referencias web manuales (puedes ofrecer estos enlaces sin afirmar que leíste su contenido)\n' +
        agent.webReferences.map((r) => `- ${r.title}: ${r.url} — ${r.description}`).join('\n'),
    );
  }
  if (media.length) {
    if (media.length <= 40) {
      parts.push(
        '## Librería de imágenes y archivos (usa mostrar_recursos con los ids)\n' +
          media.map((m) => `- id="${m.id}" · ${m.name}: ${m.description}${m.tags?.length ? ` [${m.tags.join(', ')}]` : ''}`).join('\n'),
      );
    } else parts.push(`## Librería de medios\n${media.length} recursos. Usa buscar_imagenes y luego mostrar_recursos.`);
  }
  const text = parts.join('\n\n');
  knowledgeCache.set(agent.id, { at: Date.now(), text });
  return text;
}

function channelRules(channel: Channel): string {
  if (channel === 'whatsapp')
    return 'Canal: WhatsApp. Usa mensajes breves, *negritas* con un asterisco, listas con guiones. No uses tablas Markdown ni encabezados #. Máximo ~700 caracteres por respuesta salvo que el usuario pida detalle.';
  if (channel === 'voice')
    return 'Canal: VOZ. Tu respuesta se leerá en voz alta: sin Markdown, sin listas largas, sin URLs completas, sin emojis. Frases cortas y naturales, máximo 3-4 oraciones.';
  return 'Canal: chat web. Puedes usar Markdown (negritas, listas y tablas cuando ayuden a comparar datos).';
}

export async function buildSystemPrompt(p: {
  agent: Agent;
  session: Session;
  channel: Channel;
  site?: Site | null;
  recovery?: RecoveryContext | null;
}): Promise<any[]> {
  const { agent, session, channel, site, recovery } = p;
  const I = agent.instructions || ({} as Agent['instructions']);
  const lq = agent.leadQualification;

  const staticPart = `# Instrucción principal
${I.main || 'Eres un asesor conversacional profesional.'}

# Identidad, marca y reglas específicas del agente "${agent.name}"
${I.specific || ''}

# Estilo de respuesta
${I.responseStyle || 'Respuestas claras, breves y en primera persona.'}

# Etapas de la conversación
## Inicio
${I.stageStart || 'Saluda y ofrece ayuda.'}
## Desarrollo
${I.stageConversation || 'Responde con precisión, aprovecha el contexto y avanza hacia el objetivo.'}
## Cierre
${I.stageClosing || 'Resume, agradece y confirma el siguiente paso.'}

# Reglas de operación (obligatorias)
1. No inventes datos (precios, disponibilidad, promociones, direcciones). Usa solo información de herramientas, documentos o de estas instrucciones. Si no la tienes, dilo y ofrece una alternativa.
2. Aprovecha el contexto: si el usuario ya indicó marca, modelo, versión, ubicación o datos de contacto, no vuelvas a preguntarlos. Interpreta respuestas cortas ("sí", "ese", "dame una imagen") según el mensaje anterior; si hay varias interpretaciones y afecta una acción comercial, confirma antes.
3. Distingue CONSULTAR de EJECUTAR: las herramientas api_* solo obtienen información; los flujos flujo_* realizan operaciones de negocio y solo deben ejecutarse cuando se cumplan sus condiciones y el usuario lo haya confirmado.
4. Solo confirma al usuario una operación como exitosa si la herramienta devolvió "accepted": true. Si fue rechazada o falló, explícalo con tacto y ofrece seguimiento.
5. Si piden una imagen, elige el recurso que corresponda al producto/modelo del contexto vigente; si el contexto no basta, pregunta cuál.
6. Cuando el usuario dé una ubicación (ciudad o código postal), úsala como referencia de búsqueda de distribuidores; nunca presentes resultados de otra ubicación como si fueran de la solicitada.
7. Fuera de tu ámbito: indícalo amablemente y regresa al propósito del agente.
8. Captura datos de forma progresiva, solo cuando sean necesarios; registra lo obtenido con registrar_datos_contacto.

# Criterios de uso de herramientas
${I.toolsCriteria || 'Consulta el conocimiento cuando la pregunta requiera datos documentales; usa servicios externos para información dinámica.'}

${
  lq?.enabled
    ? `# Cualificación de leads
Datos requeridos antes de registrar una oportunidad: ${(lq.requiredFields || []).join(', ') || 'nombre y contacto'}.
Regla de contacto: ${{ phone: 'teléfono', email: 'correo', phone_or_email: 'teléfono o correo', phone_and_email: 'teléfono y correo' }[lq.contactRule] || 'teléfono o correo'}.
Señales de interés: ${lq.signals || 'solicitud de cotización, asesor, prueba de manejo, disponibilidad'}.
${lq.rules || ''}`
    : ''
}

# Sugerencias de siguiente paso (CTA)
${I.ctaCriteria || 'Sugiere hasta 3 opciones útiles relacionadas con tu última respuesta.'}
Formato: si corresponde sugerir opciones, termina tu respuesta con una línea EXACTA: <ctas>["Opción 1","Opción 2"]</ctas> (máx. 4 opciones, ≤ 24 caracteres cada una). No sugieras acciones que no puedas realizar ni repitas pasos ya completados. Omite la línea al cerrar una gestión o cuando esperas una confirmación puntual.

# Conocimiento disponible
${await knowledgeSummary(agent)}
`;

  const contact = session.contact || {};
  const runs = Object.entries(session.flowRuns || {});
  let dynamicPart = `# Contexto de la sesión
Fecha y hora actual: ${new Date().toLocaleString('es-MX', { timeZone: config.defaultTimezone })}
${channelRules(channel)}
Origen: ${session.origin === 'recovery' ? 'XSIA Recovery' : 'chat estándar'}
Datos del usuario ya conocidos: ${Object.keys(contact).length ? JSON.stringify(contact) : 'ninguno'}
${runs.length ? `Flujos ya ejecutados en esta conversación (no repetir): ${runs.map(([k, v]) => `${k}=${v.status}`).join(', ')}` : ''}
${I.welcomeMessage && session.origin !== 'recovery' ? `Ya saludaste al usuario con: "${I.welcomeMessage}". No repitas el saludo.` : ''}
${session.handoff ? 'La conversación ya fue transferida a un asesor humano.' : ''}`;

  if (site) {
    dynamicPart += `

# Sitio / distribuidor que origina la conversación
Nombre: ${site.name} (clave ${site.key}${site.dealerCode ? `, código distribuidor ${site.dealerCode}` : ''})
${site.instructions || ''}
Nota: la identidad del sitio no es la ubicación del cliente; si el cliente pide otra ubicación, usa la del cliente.`;
  }

  if (recovery) {
    const { campaign, lead } = recovery;
    const tpl = campaign.templates?.[lead.type];
    dynamicPart += `

# XSIA RECOVERY — Campaña "${campaign.name}"
Estás retomando una oportunidad comercial previa. El cliente respondió al mensaje de reactivación.
Mensaje inicial enviado al cliente: "${recovery.templateText || tpl?.name || ''}"
Contexto del mensaje inicial: ${tpl?.context || ''}
Instrucciones de la campaña: ${campaign.agentInstructions || ''}

## Datos del lead
Nombre: ${[lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'n/d'}
Teléfono: ${lead.phone} · Correo: ${lead.email || 'n/d'} · CP: ${lead.zip || 'n/d'}
Tipo: ${TYPE_LABEL[lead.type]}${lead.reason ? ` · Motivo previo: ${lead.reason}` : ''}
Interés: ${[lead.brand, lead.model, lead.version, lead.year].filter(Boolean).join(' ') || 'n/d'}
Distribuidor original: ${lead.originalDealerName || 'n/d'} (id ${lead.originalDealerId || 'n/d'})
Fecha original: ${lead.originalDate || 'n/d'}
Historial: ${lead.summary || 'n/d'}
Estado actual: ${lead.status}${lead.outcome ? ` · Resultado: ${lead.outcome}` : ''}${lead.selectedDealer ? ` · Distribuidor elegido: ${lead.selectedDealer.name}` : ''}${lead.crm?.status === 'accepted' ? ' · YA TRANSFERIDO AL CRM (no repetir)' : ''}

## Flujo de recuperación
1. Primer objetivo: confirmar si desea continuar con su interés previo (registra con confirmar_interes).
2. Si confirma: pide/usa su ubicación (CP o ciudad) y ofrece opciones con buscar_distribuidores${campaign.crm?.excludeOriginalDealer ? ' (excluye el distribuidor original)' : ''}. Presenta las opciones sin CTA ni preguntas adicionales.
3. Cuando elija: ejecuta seleccionar_distribuidor_y_transferir. Si "accepted", confirma usando su nombre y el del distribuidor que se dará seguimiento a su interés en el vehículo. No muestres menús después de confirmar. La información de atención a clientes se envía aparte automáticamente.
4. Si no le interesa: respétalo, usa cerrar_sin_interes y despídete sin insistir.
5. Si pide no recibir mensajes: usa registrar_no_contactar y confirma.
6. Si expresa una queja: reconócela y usa registrar_queja.
7. Si ya fue atendido: no repitas ofertas; valora cerrar.
Respuestas cortas, en primera persona, una pregunta o decisión por mensaje. No ofrezcas cotización o prueba de manejo si el historial indica que ya ocurrió.`;
  }

  return [
    { type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicPart },
  ];
}

export function invalidateKnowledgeSummary(agentId: string) {
  knowledgeCache.delete(agentId);
}
