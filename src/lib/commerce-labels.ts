/** Etiquetas y estilos de estado para cotizaciones, ventas y casos. [texto, clase de la insignia] */
export const QUOTE_STATUS: Record<string, [string, string]> = {
  draft: ['Borrador', ''], sent: ['Enviada', 'badge-warn'], accepted: ['Aceptada', 'badge-ok'], rejected: ['Rechazada', 'badge-danger'], superseded: ['Reemplazada', ''],
};
export const SALE_STATUS: Record<string, [string, string]> = {
  confirmed: ['Confirmada', 'badge-ok'], delivered: ['Entregada', 'badge-ok'], cancelled: ['Anulada', 'badge-danger'],
};
export const CASE_STATUS: Record<string, [string, string]> = {
  open: ['Abierto', 'badge-warn'], in_progress: ['En curso', 'badge-warn'], resolved: ['Resuelto', 'badge-ok'], closed: ['Cerrado', ''],
};
export const CASE_KIND: Record<string, string> = { support: 'Soporte', complaint: 'Reclamo', warranty: 'Garantía', return: 'Devolución', question: 'Pregunta' };
export const PRIORITY: Record<string, string> = { low: 'Baja', normal: 'Normal', high: 'Alta', urgent: 'Urgente' };
export const CASE_NEXT: Record<string, { to: string; label: string }[]> = {
  open: [{ to: 'in_progress', label: 'Tomar caso' }, { to: 'resolved', label: 'Marcar resuelto' }],
  in_progress: [{ to: 'resolved', label: 'Marcar resuelto' }, { to: 'open', label: 'Devolver a abierto' }],
  resolved: [{ to: 'closed', label: 'Cerrar' }, { to: 'open', label: 'Reabrir' }],
  closed: [{ to: 'open', label: 'Reabrir (manager)' }],
};
