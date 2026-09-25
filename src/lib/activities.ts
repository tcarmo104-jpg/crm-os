import { dayKey, daysBetween } from './time';

/** Catálogo único de tipos de Actividad (interacción ya ocurrida). Comparte forma con los tipos de Tarea donde aplica,
 * pero sin «Seguimiento» ni «Otra» (esos son de planificación, no de historial). */
export const ACTIVITY_TYPES = ['call', 'whatsapp', 'email', 'meeting', 'visit', 'note'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export const ACTIVITY_TYPE_LABEL: Record<ActivityType, string> = {
  call: 'Llamada', whatsapp: 'WhatsApp', email: 'Correo', meeting: 'Reunión', visit: 'Visita', note: 'Nota',
};
export const ACTIVITY_TYPE_ICON: Record<ActivityType, string> = {
  call: 'phone', whatsapp: 'chat', email: 'mail', meeting: 'users', visit: 'pin', note: 'file',
};
/** Solo estos tipos tienen «entrante / saliente» (una reunión, visita o nota no la inicia nadie en particular). */
export const DIRECTIONAL_TYPES: ActivityType[] = ['call', 'whatsapp', 'email'];
export const DIRECTION_LABEL: Record<string, string> = { inbound: 'Entrante', outbound: 'Saliente' };

/** «Hoy», «Ayer», o la fecha completa: para encabezar el historial agrupado por día. */
export function dayHeading(iso: string, now: Date, tz: string, locale = 'es'): string {
  const d = daysBetween(dayKey(iso, tz), dayKey(now, tz));
  if (d === 0) return 'Hoy';
  if (d === 1) return 'Ayer';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: dayKey(iso, tz).slice(0, 4) === dayKey(now, tz).slice(0, 4) ? undefined : 'numeric', timeZone: tz }).format(new Date(iso));
}

/** Agrupa actividades (ya ordenadas del más reciente al más antiguo) por día de calendario en la zona de la organización. */
export function groupActivitiesByDay<T extends { occurredAt: string }>(items: T[], now: Date, tz: string): { key: string; heading: string; items: T[] }[] {
  const out: { key: string; heading: string; items: T[] }[] = [];
  for (const it of items) {
    const key = dayKey(it.occurredAt, tz);
    const last = out[out.length - 1];
    if (last?.key === key) last.items.push(it);
    else out.push({ key, heading: dayHeading(it.occurredAt, now, tz), items: [it] });
  }
  return out;
}
