/** Estado de la pantalla del Inbox codificado en la URL (así se puede compartir, recargar y volver atrás). */
export const INBOX_TABS = [
  { key: 'all', label: 'Todas' },
  { key: 'unread', label: 'No leídas' },
  { key: 'pending', label: 'Pendientes' },
  { key: 'mine', label: 'Mías' },
  { key: 'unassigned', label: 'Sin asignar' },
  { key: 'closed', label: 'Cerradas' },
] as const;
export type InboxTab = (typeof INBOX_TABS)[number]['key'];

export const CHANNELS = ['whatsapp', 'instagram', 'facebook', 'gmail'] as const;
export type ChannelKind = (typeof CHANNELS)[number];
export const CHANNEL_LABEL: Record<ChannelKind, string> = { whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Messenger', gmail: 'Gmail' };

/** Plazo para responder con texto libre desde el último mensaje del cliente: 24 h en mensajería, 30 días en correo. */
export const replyWindowMs = (kind: ChannelKind) => (kind === 'gmail' ? 30 : 1) * 24 * 60 * 60 * 1000;

/** Cómo se identifica al contacto en el encabezado (su teléfono, su correo; en Messenger/Instagram no hay dato visible). */
export function contactLabel(kind: ChannelKind, threadKey: string, phone: string | null): string {
  if (kind === 'gmail') return threadKey;
  if (kind === 'whatsapp') return `+${phone ?? threadKey}`;
  return '';
}

export interface InboxQuery {
  tab: InboxTab;
  q: string;
  canal: '' | ChannelKind;
  asesor: string;              // '' | 'none' | uuid
  etiqueta: string;            // '' | uuid
  fecha: '' | 'hoy' | '7d' | '30d';
  estado: '' | 'open' | 'closed';
  c: string;                   // conversación abierta ('' | uuid)
}
export const EMPTY_QUERY: InboxQuery = { tab: 'all', q: '', canal: '', asesor: '', etiqueta: '', fecha: '', estado: '', c: '' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Raw = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

export function parseInboxQuery(sp: Raw): InboxQuery {
  const tab = INBOX_TABS.find((t) => t.key === one(sp.f))?.key ?? 'all';
  const canal = CHANNELS.find((c) => c === one(sp.canal)) ?? '';
  const asesor = one(sp.asesor);
  const fecha = (['hoy', '7d', '30d'] as const).find((f) => f === one(sp.fecha)) ?? '';
  const estado = (['open', 'closed'] as const).find((e) => e === one(sp.estado)) ?? '';
  return {
    tab, canal, fecha, estado,
    q: one(sp.q).replace(/\s+/g, ' ').trim().slice(0, 80),
    asesor: asesor === 'none' || UUID.test(asesor) ? asesor : '',
    etiqueta: UUID.test(one(sp.etiqueta)) ? one(sp.etiqueta) : '',
    c: UUID.test(one(sp.c)) ? one(sp.c) : '',
  };
}

const PARAM: Record<keyof InboxQuery, string> = { tab: 'f', q: 'q', canal: 'canal', asesor: 'asesor', etiqueta: 'etiqueta', fecha: 'fecha', estado: 'estado', c: 'c' };

/** Construye /inbox?… omitiendo los valores por defecto. */
export function inboxHref(base: InboxQuery, overrides: Partial<InboxQuery> = {}): string {
  const q = { ...base, ...overrides };
  const p = new URLSearchParams();
  for (const k of Object.keys(PARAM) as (keyof InboxQuery)[]) {
    const v = q[k];
    if (v && !(k === 'tab' && v === 'all')) p.set(PARAM[k], v);
  }
  const s = p.toString();
  return s ? `/inbox?${s}` : '/inbox';
}

/** Cuántos filtros avanzados hay activos (para el indicador del botón «Filtros»). */
export function activeAdvancedFilters(q: InboxQuery): number {
  return [q.canal, q.asesor, q.etiqueta, q.fecha, q.estado].filter(Boolean).length;
}

export function dateFrom(fecha: InboxQuery['fecha'], now = new Date()): string | null {
  if (!fecha) return null;
  const d = new Date(now);
  if (fecha === 'hoy') d.setHours(0, 0, 0, 0);
  else d.setTime(d.getTime() - (fecha === '7d' ? 7 : 30) * 24 * 3600 * 1000);
  return d.toISOString();
}

/** Texto seguro para usar dentro de un filtro `or(...)` de PostgREST (sin comodines ni separadores). */
export function safeSearchText(raw: string): string {
  return raw.replace(/[,()*%_\\"'`;:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Cookie que recuerda si la ficha del cliente está abierta (solo en pantallas anchas). */
export const INBOX_CONTEXT_COOKIE = 'crm_ib_ctx';
export function parseContextCookie(raw: string | undefined): 'open' | 'closed' {
  return raw === 'closed' ? 'closed' : 'open';
}
