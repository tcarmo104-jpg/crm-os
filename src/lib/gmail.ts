/** Lógica pura de Gmail: leer un correo de la API, decidir si es relevante y construir una respuesta. Sin red. */

export interface GmailPart { mimeType?: string; filename?: string; body?: { data?: string; size?: number; attachmentId?: string }; headers?: { name: string; value: string }[]; parts?: GmailPart[] }
export interface GmailMessage { id: string; threadId?: string; labelIds?: string[]; internalDate?: string; snippet?: string; payload?: GmailPart }
export interface ParsedEmail {
  id: string; threadId: string | null; fromEmail: string; fromName: string | null; subject: string; messageId: string | null; references: string | null;
  occurredAt: string; body: string; attachments: number; labels: string[]; bulk: boolean;
  files: { fileName: string; mime: string; size: number | null; attachmentId: string; inline: boolean }[];
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const header = (p: GmailPart | undefined, name: string): string | null => {
  const h = (p?.headers ?? []).find((x) => isStr(x?.name) && x.name.toLowerCase() === name.toLowerCase());
  return h && isStr(h.value) ? h.value : null;
};
const decode = (data: string | undefined): string => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

/** «Ana Gómez <ana@x.com>» → { name, email }. Devuelve null si no hay un correo válido. */
export function parseAddress(raw: string | null | undefined): { name: string | null; email: string } | null {
  if (!raw) return null;
  const m = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/) ?? raw.match(/^\s*()([^<>\s,;]+@[^<>\s,;]+)\s*$/);
  if (!m) return null;
  const email = m[2]!.toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return null;
  const name = (m[1] ?? '').trim().replace(/\s+/g, ' ');
  return { name: name && name.toLowerCase() !== email ? name.slice(0, 160) : null, email };
}

/** Decodifica palabras codificadas del asunto (=?UTF-8?B?...?= / =?UTF-8?Q?...?=). */
export function decodeHeader(v: string | null): string {
  if (!v) return '';
  return v.replace(/=\?([\w-]+)\?([BbQq])\?([^?]*)\?=/g, (_m, cs: string, enc: string, txt: string) => {
    try {
      const buf = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return new TextDecoder(/utf-?8/i.test(cs) ? 'utf-8' : 'latin1').decode(buf);
    } catch { return txt; }
  }).replace(/\s+/g, ' ').trim();
}

function walk(p: GmailPart | undefined, acc: { plain: string[]; html: string[]; files: number; list: ParsedEmail['files'] }) {
  if (!p) return;
  if (p.filename) {
    acc.files++;
    const disp = (p.headers ?? []).find((h) => isStr(h?.name) && h.name.toLowerCase() === 'content-disposition')?.value ?? '';
    if (p.body?.attachmentId && acc.list.length < 20) acc.list.push({ fileName: p.filename, mime: p.mimeType ?? 'application/octet-stream', size: typeof p.body.size === 'number' ? p.body.size : null, attachmentId: p.body.attachmentId, inline: /^\s*inline/i.test(disp) });
  }
  else if (p.mimeType === 'text/plain' && p.body?.data) acc.plain.push(decode(p.body.data));
  else if (p.mimeType === 'text/html' && p.body?.data) acc.html.push(decode(p.body.data));
  for (const c of p.parts ?? []) walk(c, acc);
}

const stripHtml = (h: string) => h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Deja solo lo nuevo del correo: corta la cita del mensaje anterior y las líneas «> …». */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cut = lines.findIndex((l) => /^\s*(El .{5,120} escribió:|On .{5,120} wrote:|-{2,}\s*(Original Message|Mensaje original)|De:\s.+|From:\s.+@)/i.test(l) && true);
  const kept = (cut > 0 ? lines.slice(0, cut) : lines).filter((l) => !/^\s*>/.test(l));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseGmailMessage(m: GmailMessage): ParsedEmail | null {
  if (!isStr(m?.id) || !m.payload) return null;
  const from = parseAddress(header(m.payload, 'From'));
  if (!from) return null;
  const acc = { plain: [] as string[], html: [] as string[], files: 0, list: [] as ParsedEmail['files'] };
  walk(m.payload, acc);
  const raw = acc.plain.join('\n').trim() || stripHtml(acc.html.join('\n')).replace(/[ \t]+/g, ' ').trim() || (m.snippet ?? '');
  const ms = Number(m.internalDate);
  const auto = (header(m.payload, 'Auto-Submitted') ?? 'no').toLowerCase() !== 'no';
  const prec = (header(m.payload, 'Precedence') ?? '').toLowerCase();
  return {
    id: m.id, threadId: isStr(m.threadId) ? m.threadId : null, fromEmail: from.email, fromName: from.name,
    subject: decodeHeader(header(m.payload, 'Subject')).slice(0, 300), messageId: header(m.payload, 'Message-ID')?.trim() ?? null,
    references: header(m.payload, 'References')?.trim().slice(0, 1500) ?? null,
    occurredAt: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString(),
    body: stripQuoted(raw) || raw.trim(), attachments: acc.files, files: acc.list, labels: (m.labelIds ?? []).filter(isStr),
    bulk: header(m.payload, 'List-Unsubscribe') !== null || auto || ['bulk', 'list', 'junk'].includes(prec),
  };
}

const NOISE_LABELS = ['SENT', 'DRAFT', 'SPAM', 'TRASH', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];
/** Solo mensajes relevantes: correo directo de una persona, no promociones, notificaciones ni el propio buzón. */
export function shouldSync(e: ParsedEmail, ownEmail: string): { sync: true } | { sync: false; reason: string } {
  if (e.fromEmail === ownEmail.toLowerCase()) return { sync: false, reason: 'own' };
  const noise = e.labels.find((l) => NOISE_LABELS.includes(l));
  if (noise) return { sync: false, reason: noise.toLowerCase() };
  if (!e.labels.includes('INBOX')) return { sync: false, reason: 'not_inbox' };
  if (e.bulk) return { sync: false, reason: 'bulk' };
  if (/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounce)/i.test(e.fromEmail.split('@')[0]!)) return { sync: false, reason: 'automated' };
  return { sync: true };
}

/** Cuerpo que se guarda en el Inbox: asunto + texto nuevo (+ aviso de adjuntos). */
export function inboxBody(e: ParsedEmail): string {
  const files = e.attachments > 0 ? `\n[${e.attachments} ${e.attachments === 1 ? 'adjunto' : 'adjuntos'}]` : '';
  return `${e.subject ? `${e.subject}\n\n` : ''}${e.body}${files}`.trim().slice(0, 4096);
}

// ---------------------------------------------------------------------------------------------- respuesta
export const replySubject = (s: string | null | undefined) => { const t = (s ?? '').trim(); return /^(re|rv):/i.test(t) ? t : `Re: ${t || '(sin asunto)'}`; };
const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const safeHeader = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

/** Correo RFC 822 en texto plano UTF-8, en base64url (lo que pide `users.messages.send`). Bloquea la inyección de cabeceras. */
export function buildRawEmail(o: { from: string; to: string; subject: string; body: string; inReplyTo?: string | null; references?: string | null; fromName?: string | null }): string {
  if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(o.to) || !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(o.from)) throw new Error('invalid_address');
  const from = o.fromName ? `${encWord(safeHeader(o.fromName))} <${o.from}>` : o.from;
  const refs = [o.references, o.inReplyTo].filter(Boolean).map((x) => safeHeader(x as string)).join(' ').trim();
  const head = [`From: ${from}`, `To: ${o.to}`, `Subject: ${encWord(safeHeader(o.subject))}`, ...(o.inReplyTo ? [`In-Reply-To: ${safeHeader(o.inReplyTo)}`] : []), ...(refs ? [`References: ${refs}`] : []),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64'];
  const body = Buffer.from(o.body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return Buffer.from(`${head.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url');
}
