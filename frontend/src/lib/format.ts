export const fmtDate = (v?: string | null) => (v ? new Date(v).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const fmtDay = (v?: string | null) => (v ? new Date(v).toLocaleDateString('es-MX') : '—');
export const fmtNum = (n?: number) => (n ?? 0).toLocaleString('es-MX');
export const fmtUsd = (n?: number) => `$${(n ?? 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USD`;
export const pct = (n?: number) => `${(n ?? 0).toLocaleString('es-MX', { maximumFractionDigits: 1 })}%`;

export const LEAD_TYPE_LABEL: Record<string, string> = {
  NOT_CONTACTED: 'No contactado',
  ABANDONED: 'Abandonado',
  REJECTED: 'Rechazado',
};
export const LEAD_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendiente',
  SCHEDULED: 'Programado',
  SENDING: 'Enviando',
  SENT: 'Enviado',
  DELIVERED: 'Entregado',
  READ: 'Leído',
  REPLIED: 'Respondido',
  FAILED: 'Fallido',
  CANCELLED: 'Cancelado',
  NO_RESPONSE: 'Sin respuesta',
};
export const OUTCOME_LABEL: Record<string, string> = {
  INTERESTED: 'Con interés',
  RECOVERED: 'Recuperado',
  NOT_RECOVERED: 'No recuperado',
  NOT_INTERESTED: 'Sin interés',
  COMPLAINT: 'Queja',
  OPTOUT: 'No contactar',
};
export const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador',
  running: 'En ejecución',
  paused: 'En pausa',
  cancelled: 'Cancelada',
  completed: 'Completada',
};
