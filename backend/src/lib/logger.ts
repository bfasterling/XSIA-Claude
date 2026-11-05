/** Logging estructurado compatible con Cloud Logging */
type Sev = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
function log(severity: Sev, message: string, extra?: Record<string, any>) {
  const entry = { severity, message, ...(extra || {}) };
  const line = JSON.stringify(entry, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v));
  if (severity === 'ERROR') console.error(line);
  else console.log(line);
}
export const logger = {
  debug: (m: string, e?: Record<string, any>) => process.env.DEBUG && log('DEBUG', m, e),
  info: (m: string, e?: Record<string, any>) => log('INFO', m, e),
  warn: (m: string, e?: Record<string, any>) => log('WARNING', m, e),
  error: (m: string, e?: Record<string, any>) => log('ERROR', m, e),
};
