/** Catálogo de Reglas de distribución: opciones, validación, etiquetas. Lógica pura. */
export const CHANNEL_KINDS = ['whatsapp', 'facebook', 'instagram', 'gmail'] as const;
export type ChannelKindFilter = (typeof CHANNEL_KINDS)[number];
export const CHANNEL_KIND_LABEL: Record<ChannelKindFilter, string> = { whatsapp: 'WhatsApp', facebook: 'Facebook Messenger', instagram: 'Instagram Direct', gmail: 'Gmail' };

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_LABEL: Record<Weekday, string> = { 1: 'Lun', 2: 'Mar', 3: 'Mié', 4: 'Jue', 5: 'Vie', 6: 'Sáb', 7: 'Dom' };
export const WEEKDAY_LABEL_LONG: Record<Weekday, string> = { 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes', 6: 'Sábado', 7: 'Domingo' };

/** HH:MM de un <input type="time">, siempre con 2 dígitos. */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Resumen legible de a quién aplica una regla, para la lista de administración. */
export function describeScope(r: { channelKind: string | null; region: string | null; hasHours: boolean }): string {
  const parts: string[] = [];
  parts.push(r.channelKind ? (CHANNEL_KIND_LABEL as Record<string, string>)[r.channelKind] ?? r.channelKind : 'Cualquier canal');
  if (r.region) parts.push(`región «${r.region}»`);
  if (r.hasHours) parts.push('con horario');
  return parts.join(' · ');
}
