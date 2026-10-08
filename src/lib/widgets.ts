/** Catálogo del Widget de WhatsApp: opciones, validación, construcción del enlace de WhatsApp. Lógica pura. */
export const WIDGET_POSITIONS = ['bottom-right', 'bottom-left'] as const;
export type WidgetPosition = (typeof WIDGET_POSITIONS)[number];
export const POSITION_LABEL: Record<WidgetPosition, string> = { 'bottom-right': 'Abajo a la derecha', 'bottom-left': 'Abajo a la izquierda' };

export const WIDGET_SIZES = ['small', 'medium', 'large'] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];
export const SIZE_LABEL: Record<WidgetSize, string> = { small: 'Pequeño', medium: 'Mediano', large: 'Grande' };

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Limpia una lista de dominios escrita a mano: quita protocolo, espacios, barras finales, duplicados. */
export function normalizeDomainList(raw: string): string[] {
  const out = new Set<string>();
  for (const line of raw.split(/[\n,]/)) {
    const d = line.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    if (d) out.add(d);
  }
  return [...out];
}

/** Arma el enlace de WhatsApp (wa.me) con el número y el mensaje ya escritos, listo para redirigir. */
export function buildWhatsAppLink(phone: string, message: string): string {
  const digits = phone.replace(/[^0-9]/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

/** El mensaje que de verdad se manda a WhatsApp: el que escribió el visitante, con su nombre delante para
 * que al asesor le quede claro quién es desde el primer vistazo (WhatsApp no manda el nombre del formulario). */
export function buildPrefilledMessage(name: string, userMessage: string): string {
  const base = userMessage.trim() || 'Hola, quiero más información.';
  return `Hola, soy ${name.trim()}. ${base}`;
}

// --------------------------------------------------------------------------------------------- horario de atención
/** 0 = domingo … 6 = sábado, igual que `extract(dow from …)` en Postgres — así el formulario y la base hablan el mismo idioma. */
export const WEEKDAY_LABELS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'] as const;
const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export interface BusinessHourRange { day: number; from: string; to: string }
export interface BusinessHourFormEntry { day: number; active: boolean; from: string; to: string }

/** A partir de las 7 filas del formulario (una por día), arma el arreglo que guarda la base: solo los días
 * marcados como activos, y solo si su horario es válido (de lo contrario esa fila simplemente no se guarda). */
export function buildBusinessHours(entries: BusinessHourFormEntry[]): BusinessHourRange[] {
  const out: BusinessHourRange[] = [];
  for (const e of entries) {
    if (!e.active) continue;
    if (!TIME_RE.test(e.from) || !TIME_RE.test(e.to) || e.from >= e.to) continue;
    out.push({ day: e.day, from: e.from, to: e.to });
  }
  return out;
}
