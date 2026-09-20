import type { AttachmentRow, MessageRow } from './types';

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'other';

export type ThreadItem =
  | { kind: 'message'; id: string; at: string; direction: 'inbound' | 'outbound'; body: string; status: MessageRow['status']; error: string | null;
      sentBy: string | null; auto: boolean; template: boolean; media: MediaKind | null; attachments: AttachmentRow[] }
  | { kind: 'note'; id: string; at: string; body: string; authorId: string | null }
  | { kind: 'event'; id: string; at: string; text: string };

export interface NoteInput { id: string; occurredAt: string; summary: string; createdBy: string | null }
export interface EventInput { id: string; occurredAt: string; text: string }

const MEDIA_TYPES: MediaKind[] = ['image', 'video', 'audio', 'document', 'sticker'];
export function mediaKind(m: Pick<MessageRow, 'kind' | 'meta'>): MediaKind | null {
  if (m.kind !== 'media') return null;
  const t = typeof m.meta?.type === 'string' ? m.meta.type : '';
  return (MEDIA_TYPES as string[]).includes(t) ? (t as MediaKind) : 'other';
}

/**
 * Une mensajes, notas internas y eventos del sistema en una sola línea de tiempo ordenada.
 * Un mensaje saliente sin autor humano se trata como automático (bot / sistema).
 */
/**
 * El texto de un mensaje con adjuntos: se quita la etiqueta automática («[Imagen]», «[Documento: plano.pdf]», «[Ubicación: …]»,
 * «[2 adjuntos]») porque el propio adjunto ya se ve; el pie de foto o el texto del cliente se conservan.
 */
export function visibleBody(body: string, hasAttachments: boolean): string {
  if (!hasAttachments) return body;
  return body
    .replace(/^\[(Imagen|Video|Audio|Sticker|Archivo|Documento|Ubicación|Contacto compartido|Mención en una historia|Reel|Adjunto|Enlace compartido)(: [^\]]*)?\]\s*/, '')
    .replace(/^\[\d+ adjuntos\]\s*/, '')
    .replace(/\n?\[\d+ (adjunto|adjuntos)\]\s*$/, '')
    .trim();
}

export function buildThread(messages: MessageRow[], notes: NoteInput[], events: EventInput[], attachments: AttachmentRow[] = []): ThreadItem[] {
  const byMessage = new Map<string, AttachmentRow[]>();
  for (const a of attachments) byMessage.set(a.messageId, [...(byMessage.get(a.messageId) ?? []), a]);
  const items: ThreadItem[] = [
    ...messages.map((m): ThreadItem => {
      const atts = byMessage.get(m.id) ?? [];
      return {
        kind: 'message', id: m.id, at: m.occurredAt, direction: m.direction, body: m.body, status: m.status, error: m.error,
        sentBy: m.sentBy, auto: m.direction === 'outbound' && !m.sentBy, template: m.kind === 'template',
        media: atts.length > 0 ? null : mediaKind(m),           // con adjuntos reales se dibujan ellos; si no, la tarjeta provisional de antes
        attachments: atts,
      };
    }),
    ...notes.map((n): ThreadItem => ({ kind: 'note', id: n.id, at: n.occurredAt, body: n.summary, authorId: n.createdBy })),
    ...events.map((e): ThreadItem => ({ kind: 'event', id: e.id, at: e.occurredAt, text: e.text })),
  ];
  const rank = { event: 0, message: 1, note: 2 } as const;
  return items.sort((a, b) => a.at.localeCompare(b.at) || rank[a.kind] - rank[b.kind] || a.id.localeCompare(b.id));
}

/** «Hoy», «Ayer» o la fecha, según la zona horaria de la organización. */
export function dayLabel(iso: string, timeZone: string, now = new Date()): string {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const d = new Date(iso);
  if (day(d) === day(now)) return 'Hoy';
  if (day(d) === day(new Date(now.getTime() - 24 * 3600 * 1000))) return 'Ayer';
  return new Intl.DateTimeFormat('es', { timeZone, day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

export function groupByDay(items: ThreadItem[], timeZone: string, now = new Date()): { label: string; items: ThreadItem[] }[] {
  const groups: { label: string; items: ThreadItem[] }[] = [];
  for (const it of items) {
    const label = dayLabel(it.at, timeZone, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(it);
    else groups.push({ label, items: [it] });
  }
  return groups;
}

export type TextPart = { t: 'text' | 'link'; v: string };
/** Convierte URLs http(s) en enlaces. Nada más: jamás se interpreta HTML ni otros esquemas (javascript:, data:…). */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const re = /https?:\/\/[^\s<>"'`]+/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    let url = m[0];
    const trail = /[.,;:!?)\]]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    if (start > last) parts.push({ t: 'text', v: text.slice(last, start) });
    parts.push({ t: 'link', v: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ t: 'text', v: text.slice(last) });
  return parts.length ? parts : [{ t: 'text', v: text }];
}

export const STATUS_TEXT: Record<MessageRow['status'], string> = {
  received: '', queued: 'En cola', sending: 'Enviando…', sent: 'Enviado', delivered: 'Entregado', read: 'Leído', failed: 'No se envió',
};

/** Hora corta para la lista: hoy «14:05», ayer «Ayer», antes «12/09». */
export function listTime(iso: string | null, timeZone: string, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const day = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
  if (day(d) === day(now)) {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
    return `${p.find((x) => x.type === 'hour')?.value ?? '00'}:${p.find((x) => x.type === 'minute')?.value ?? '00'}`;
  }
  if (day(d) === day(new Date(now.getTime() - 24 * 3600 * 1000))) return 'Ayer';
  // Día/mes armados a mano: así no dependen del idioma del navegador («12/9» vs «12/09»).
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}/${get('month')}`;
}
