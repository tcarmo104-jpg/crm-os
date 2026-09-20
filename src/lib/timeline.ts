import type { TimelineEvent } from './types';

export interface Described { title: string; detail?: string }

const SOURCE_LABEL: Record<string, string> = {
  api: 'API', web: 'Sitio web', csv: 'Importación CSV', manual: 'Alta manual', instagram: 'Instagram', facebook: 'Facebook', whatsapp: 'WhatsApp',
};
const LEAD_LABEL: Record<string, string> = { new: 'Nuevo', contacted: 'Contactado', qualified: 'Calificado', disqualified: 'Descartado', converted: 'Convertido' };
const ACTIVITY_LABEL: Record<string, string> = { call: 'Llamada', whatsapp: 'WhatsApp', email: 'Correo', meeting: 'Reunión', note: 'Nota' };
const s = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Texto legible de un evento del stream. Los tipos desconocidos se muestran genéricos (nunca se rompe la pantalla). */
const CHANNEL_NAME: Record<string, string> = { whatsapp: 'WhatsApp', facebook: 'Messenger', instagram: 'Instagram', gmail: 'Gmail' };

export function describeEvent(e: TimelineEvent, personName: (id: string | null | undefined) => string): Described {
  const p = e.payload;
  switch (e.type) {
    case 'customer.created': {
      const src = s(p.source);
      return { title: 'Cliente creado', detail: src ? `Origen: ${SOURCE_LABEL[src] ?? src}` : undefined };
    }
    case 'lead.created': {
      const parts = [
        s(p.source) ? `Fuente: ${SOURCE_LABEL[s(p.source)!] ?? s(p.source)}` : null,
        s(p.campaign) ? `Campaña: ${s(p.campaign)}` : null,
        p.resolution === 'matched' ? 'Ya era cliente' : null,
        p.do_not_contact === true ? 'Marcado como no contactar' : null,
      ].filter(Boolean);
      return { title: 'Lead recibido', detail: parts.join(' · ') || undefined };
    }
    case 'customer.assigned':
      return { title: p.owner_id ? `Asignado a ${personName(s(p.owner_id))}` : 'Quedó sin asignar' };
    case 'customer.dnc_set':
      return { title: 'Marcado como «no contactar»', detail: s(p.reason) };
    case 'customer.dnc_cleared':
      return { title: 'Se quitó la marca «no contactar»' };
    case 'customer.merged':
      return { title: 'Fusionado con otro registro', detail: s(p.dropped_name) ? `Se unió «${s(p.dropped_name)}»` : undefined };
    case 'identity.review_needed':
      return { title: 'Posible duplicado detectado', detail: 'Un manager debe revisarlo.' };
    case 'identity.duplicate_attempt':
      return { title: 'Alguien intentó registrar este contacto de nuevo' };
    case 'opportunity.created':
      return { title: 'Oportunidad creada', detail: [s(p.title), s(p.stage) ? `Etapa: ${s(p.stage)}` : null].filter(Boolean).join(' · ') || undefined };
    case 'opportunity.stage_changed':
      return { title: `Oportunidad movida a «${s(p.to) ?? '?'}»`, detail: [s(p.title), s(p.from) ? `Desde: ${s(p.from)}` : null].filter(Boolean).join(' · ') || undefined };
    case 'opportunity.won':
      return { title: '🎉 Oportunidad ganada', detail: s(p.title) };
    case 'opportunity.lost':
      return { title: 'Oportunidad perdida', detail: [s(p.title), s(p.reason) ? `Motivo: ${s(p.reason)}` : null].filter(Boolean).join(' · ') || undefined };
    case 'lead.status_changed':
      return {
        title: `Lead: ${LEAD_LABEL[s(p.from) ?? ''] ?? s(p.from) ?? '?'} → ${LEAD_LABEL[s(p.to) ?? ''] ?? s(p.to) ?? '?'}`,
        detail: s(p.reason),
      };
    case 'task.created':
      return { title: 'Tarea creada', detail: s(p.title) };
    case 'task.completed':
      return { title: 'Tarea completada', detail: [s(p.title), s(p.outcome) ? `Resultado: ${s(p.outcome)}` : null].filter(Boolean).join(' · ') || undefined };
    case 'task.cancelled':
      return { title: 'Tarea cancelada', detail: s(p.title) };
    case 'task.reopened':
      return { title: 'Tarea reabierta', detail: s(p.title) };
    case 'activity.logged': {
      const kind = ACTIVITY_LABEL[s(p.type) ?? ''] ?? 'Actividad';
      const dir = p.direction === 'inbound' ? ' (entrante)' : p.direction === 'outbound' ? ' (saliente)' : '';
      return { title: `${kind}${dir}`, detail: s(p.summary) };
    }
    case 'conversation.opened':
      return { title: `Escribió por ${CHANNEL_NAME[s(p.channel) ?? ''] ?? 'WhatsApp'} por primera vez` };
    case 'conversation.reopened':
      return { title: `El cliente volvió a escribir por ${CHANNEL_NAME[s(p.channel) ?? ''] ?? 'WhatsApp'}` };
    case 'quote.created':
      return { title: 'Cotización creada', detail: s(p.number) };
    case 'quote.sent':
      return { title: 'Cotización enviada', detail: s(p.number) };
    case 'quote.accepted':
      return { title: '✔ Cotización aceptada', detail: s(p.number) };
    case 'quote.rejected':
      return { title: 'Cotización rechazada', detail: [s(p.number), s(p.reason) ? `Motivo: ${s(p.reason)}` : null].filter(Boolean).join(' · ') || undefined };
    case 'sale.created':
      return { title: '🎉 Venta registrada', detail: s(p.number) };
    case 'sale.delivered':
      return { title: 'Venta entregada', detail: s(p.number) };
    case 'sale.cancelled':
      return { title: 'Venta anulada', detail: [s(p.number), s(p.reason) ? `Motivo: ${s(p.reason)}` : null].filter(Boolean).join(' · ') || undefined };
    case 'case.opened':
      return { title: 'Caso abierto', detail: [s(p.number), s(p.title)].filter(Boolean).join(' · ') || undefined };
    case 'case.status_changed': {
      const L: Record<string, string> = { open: 'abierto', in_progress: 'en curso', resolved: 'resuelto', closed: 'cerrado' };
      return { title: `Caso ${L[s(p.to) ?? ''] ?? s(p.to) ?? ''}`, detail: s(p.number) };
    }
    default:
      return { title: e.type };
  }
}
