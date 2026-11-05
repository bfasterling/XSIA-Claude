import { CloudTasksClient } from '@google-cloud/tasks';
import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Cola de tareas asíncronas.
 *  - En GCP: Cloud Tasks -> servicio "worker" de Cloud Run (privado, autenticado con OIDC).
 *  - En local (WORKER_URL vacío): ejecución en el mismo proceso.
 */
export type TaskHandler = (payload: any) => Promise<any>;
const handlers = new Map<string, TaskHandler>();

export function registerTask(name: string, handler: TaskHandler) {
  handlers.set(name, handler);
}
export function getTaskHandler(name: string) {
  return handlers.get(name);
}
export function taskNames() {
  return [...handlers.keys()];
}

let client: CloudTasksClient | null = null;
const tasksClient = () => (client ??= new CloudTasksClient());

/** Error que indica a Cloud Tasks que reintente más tarde */
export class RetryLater extends Error {
  constructor(msg = 'retry later') {
    super(msg);
  }
}

export async function enqueue(
  name: string,
  payload: any,
  opts: { queue?: string; delaySeconds?: number; scheduleAt?: Date; dedupeId?: string } = {},
) {
  if (!config.tasks.workerUrl) {
    const h = handlers.get(name);
    if (!h) throw new Error(`Tarea no registrada: ${name}`);
    const delay = opts.scheduleAt ? Math.max(0, opts.scheduleAt.getTime() - Date.now()) : (opts.delaySeconds || 0) * 1000;
    const run = async (attempt = 1): Promise<void> => {
      try {
        await h(payload);
      } catch (e: any) {
        if (e instanceof RetryLater && attempt < 10) {
          setTimeout(() => run(attempt + 1), 2000 * attempt);
          return;
        }
        logger.error(`Tarea local ${name} falló`, { error: e });
      }
    };
    setTimeout(() => void run(), delay);
    return { name: `local-${name}-${Date.now()}` };
  }

  const queue = opts.queue || config.tasks.queueDefault;
  const parent = tasksClient().queuePath(config.projectId, config.tasks.queueLocation, queue);
  const scheduleMs = opts.scheduleAt ? opts.scheduleAt.getTime() : opts.delaySeconds ? Date.now() + opts.delaySeconds * 1000 : 0;
  const task: any = {
    httpRequest: {
      httpMethod: 'POST',
      url: `${config.tasks.workerUrl.replace(/\/$/, '')}/tasks/${name}`,
      headers: {
        'Content-Type': 'application/json',
        ...(config.tasks.sharedSecret ? { 'X-Tasks-Secret': config.tasks.sharedSecret } : {}),
      },
      body: Buffer.from(JSON.stringify(payload)).toString('base64'),
      ...(config.tasks.invokerServiceAccount
        ? { oidcToken: { serviceAccountEmail: config.tasks.invokerServiceAccount, audience: config.tasks.workerUrl } }
        : {}),
    },
    dispatchDeadline: { seconds: 900 },
  };
  if (scheduleMs) task.scheduleTime = { seconds: Math.floor(scheduleMs / 1000) };
  if (opts.dedupeId) task.name = `${parent}/tasks/${opts.dedupeId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 480)}`;
  try {
    const [res] = await tasksClient().createTask({ parent, task });
    return res;
  } catch (e: any) {
    // ALREADY_EXISTS -> tarea deduplicada
    if (e?.code === 6) return { name: task.name };
    throw e;
  }
}
