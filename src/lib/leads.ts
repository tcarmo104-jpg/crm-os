/**
 * Máquina de estados de los leads. ESPEJO de app.leads_status_guard (SQL): la base de datos es la autoridad;
 * esto solo decide qué opciones mostrar. Una prueba compara ambas.
 */
export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'disqualified' | 'converted';

export const LEAD_STATUS_LABEL: Record<string, string> = {
  new: 'Nuevo', contacted: 'Contactado', qualified: 'Calificado', disqualified: 'Descartado', converted: 'Convertido',
};
/** Un estado = un color, igual que en Tareas. */
export const LEAD_STATUS_BADGE: Record<string, string> = {
  new: 'badge-info', contacted: 'badge-neutral', qualified: 'badge-warn', disqualified: 'badge-danger', converted: 'badge-ok',
};
export const LEAD_STATUSES: LeadStatus[] = ['new', 'contacted', 'qualified', 'disqualified', 'converted'];
export const LEAD_RESOLUTION_LABEL: Record<string, string> = { created: 'Cliente nuevo', matched: 'Ya era cliente', review: 'Posible duplicado', conflict: 'Conflicto' };

export const LEAD_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  new: ['contacted', 'qualified', 'disqualified'],
  contacted: ['qualified', 'disqualified', 'new'],
  qualified: ['contacted', 'disqualified'],          // 'converted' solo con convert_lead
  disqualified: ['new'],
  converted: [],
};

export function nextLeadStatuses(status: string): LeadStatus[] {
  return LEAD_TRANSITIONS[status as LeadStatus] ?? [];
}
export const canConvert = (status: string) => status !== 'converted' && status !== 'disqualified';
export const needsReason = (to: string) => to === 'disqualified';
