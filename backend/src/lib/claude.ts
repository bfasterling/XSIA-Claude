import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { config } from '../config.js';

/**
 * Cliente de Claude. Soporta:
 *  - API de Anthropic (ANTHROPIC_API_KEY en Secret Manager)
 *  - Claude en Vertex AI (facturación GCP, autenticación por cuenta de servicio)
 */
let client: Anthropic | null = null;
export function claude(): Anthropic {
  if (client) return client;
  if (config.claude.provider === 'vertex') {
    client = new AnthropicVertex({ projectId: config.projectId, region: config.claude.vertexRegion }) as unknown as Anthropic;
  } else {
    if (!config.claude.apiKey) throw new Error('ANTHROPIC_API_KEY no configurada');
    client = new Anthropic({ apiKey: config.claude.apiKey, maxRetries: 3 });
  }
  return client;
}

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function addUsage(acc: Usage, u: any) {
  if (!u) return acc;
  acc.input += u.input_tokens || 0;
  acc.output += u.output_tokens || 0;
  acc.cacheRead += u.cache_read_input_tokens || 0;
  acc.cacheWrite += u.cache_creation_input_tokens || 0;
  return acc;
}

export function costUsd(model: string, u: Usage): number {
  const p = config.claude.pricing;
  const key = Object.keys(p).find((k) => k !== 'default' && model.includes(k)) || 'default';
  const r = p[key];
  return (u.input * r.input + u.output * r.output + u.cacheRead * r.cacheRead + u.cacheWrite * r.cacheWrite) / 1_000_000;
}

export function textOf(msg: { content: any[] }): string {
  return (msg.content || [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');
}

/** Llamada simple de texto */
export async function complete(opts: {
  system?: string;
  prompt: string | any[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<{ text: string; usage: Usage }> {
  const model = opts.model || config.claude.fastModel;
  const res = await claude().messages.create({
    model,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0,
    system: opts.system,
    messages: [{ role: 'user', content: opts.prompt as any }],
  });
  return { text: textOf(res as any), usage: addUsage(emptyUsage(), (res as any).usage) };
}

/**
 * Salida estructurada usando una herramienta forzada (tool_choice) y su JSON schema.
 */
export async function structured<T = any>(opts: {
  system?: string;
  prompt: string | any[];
  schema: Record<string, any>;
  name?: string;
  description?: string;
  model?: string;
  maxTokens?: number;
}): Promise<{ data: T; usage: Usage }> {
  const name = opts.name || 'resultado';
  const res = await claude().messages.create({
    model: opts.model || config.claude.fastModel,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: 0,
    system: opts.system,
    tools: [{ name, description: opts.description || 'Devuelve el resultado estructurado', input_schema: opts.schema as any }],
    tool_choice: { type: 'tool', name },
    messages: [{ role: 'user', content: opts.prompt as any }],
  });
  const block: any = (res as any).content.find((b: any) => b.type === 'tool_use');
  return { data: (block?.input || {}) as T, usage: addUsage(emptyUsage(), (res as any).usage) };
}
