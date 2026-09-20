import { describe, expect, it } from 'vitest';
import { buildRawEmail, decodeHeader, inboxBody, parseAddress, parseGmailMessage, replySubject, shouldSync, stripQuoted, type GmailMessage } from './gmail';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const email = (o: { headers?: Record<string, string>; plain?: string; html?: string; labels?: string[]; files?: number; id?: string } = {}): GmailMessage => ({
  id: o.id ?? 'g1', threadId: 't1', labelIds: o.labels ?? ['INBOX', 'UNREAD'], internalDate: '1758375600000', snippet: 'snippet',
  payload: {
    mimeType: 'multipart/alternative',
    headers: Object.entries({ From: 'Ana Gómez <Ana@Ejemplo.com>', Subject: 'Cotización Wallpanel', 'Message-ID': '<abc@mail.gmail.com>', ...(o.headers ?? {}) }).map(([name, value]) => ({ name, value })),
    parts: [
      ...(o.plain !== undefined ? [{ mimeType: 'text/plain', body: { data: b64(o.plain) } }] : []),
      ...(o.html !== undefined ? [{ mimeType: 'text/html', body: { data: b64(o.html) } }] : []),
      ...Array.from({ length: o.files ?? 0 }, (_, i) => ({ mimeType: 'application/pdf', filename: `f${i}.pdf`, body: { attachmentId: 'x' } })),
    ],
  },
});

describe('direcciones y asuntos', () => {
  it('nombre y correo, en minúsculas', () => {
    expect(parseAddress('Ana Gómez <Ana@Ejemplo.com>')).toEqual({ name: 'Ana Gómez', email: 'ana@ejemplo.com' });
    expect(parseAddress('"Gómez, Ana" <ana@ejemplo.com>')).toEqual({ name: 'Gómez, Ana', email: 'ana@ejemplo.com' });
    expect(parseAddress('ana@ejemplo.com')).toEqual({ name: null, email: 'ana@ejemplo.com' });
    expect(parseAddress('<ana@ejemplo.com>')).toEqual({ name: null, email: 'ana@ejemplo.com' });
    for (const bad of [null, '', 'sin arroba', 'a@b', 'Ana <>', '<a b@c.com>']) expect(parseAddress(bad)).toBeNull();
  });
  it('asuntos con acentos codificados', () => {
    expect(decodeHeader('=?UTF-8?B?Q290aXphY2nDs24=?=')).toBe('Cotización');
    expect(decodeHeader('=?UTF-8?Q?Cotizaci=C3=B3n_Wallpanel?=')).toBe('Cotización Wallpanel');
    expect(decodeHeader('Normal')).toBe('Normal'); expect(decodeHeader(null)).toBe('');
  });
  it('«Re:» sin repetir', () => {
    expect(replySubject('Cotización')).toBe('Re: Cotización'); expect(replySubject('Re: Cotización')).toBe('Re: Cotización'); expect(replySubject('RV: x')).toBe('RV: x'); expect(replySubject('')).toBe('Re: (sin asunto)');
  });
});

describe('leer un correo', () => {
  it('remitente, asunto, cuerpo, hora e identificadores para responder', () => {
    const e = parseGmailMessage(email({ plain: 'Necesito 40 m2 de Arkodeck.\n\nGracias' }))!;
    expect(e).toMatchObject({ id: 'g1', threadId: 't1', fromEmail: 'ana@ejemplo.com', fromName: 'Ana Gómez', subject: 'Cotización Wallpanel', messageId: '<abc@mail.gmail.com>', occurredAt: '2025-09-20T13:40:00.000Z', attachments: 0, bulk: false });
    expect(e.body).toBe('Necesito 40 m2 de Arkodeck.\n\nGracias');
  });
  it('sin texto plano usa el HTML sin etiquetas ni estilos', () => {
    const e = parseGmailMessage(email({ html: '<style>p{color:red}</style><p>Hola&nbsp;equipo</p><div>Precio &amp; plazo</div>' }))!;
    expect(e.body).toContain('Hola equipo'); expect(e.body).toContain('Precio & plazo'); expect(e.body).not.toMatch(/<|color:red/);
  });
  it('corta la cita del mensaje anterior', () => {
    expect(stripQuoted('Sí, me sirve.\n\nEl sáb, 20 sept 2025 13:40, Arkos <ventas@arkos.co> escribió:\n> Le enviamos la cotización\n> saludos')).toBe('Sí, me sirve.');
    expect(stripQuoted('Ok\n> cita\nfin')).toBe('Ok\nfin');
    expect(parseGmailMessage(email({ plain: '> solo una cita\n> otra línea' }))!.body).toBe('> solo una cita\n> otra línea');   // si TODO es cita no se pierde el mensaje
  });
  it('cuenta adjuntos y los anuncia en el Inbox', () => {
    const e = parseGmailMessage(email({ plain: 'Adjunto planos', files: 2 }))!;
    expect(e.attachments).toBe(2);
    expect(inboxBody(e)).toBe('Cotización Wallpanel\n\nAdjunto planos\n[2 adjuntos]');
  });
  it('lo ilegible no rompe', () => {
    expect(parseGmailMessage({ id: 'x' } as GmailMessage)).toBeNull();
    expect(parseGmailMessage(email({ headers: { From: 'sin-correo' }, plain: 'x' }))).toBeNull();
    expect(parseGmailMessage(null as never)).toBeNull();
    expect(inboxBody(parseGmailMessage(email({ plain: 'a'.repeat(9000) }))!).length).toBe(4096);
  });
});

describe('qué correos se sincronizan', () => {
  const own = 'ventas@arkos.co';
  const decide = (o: Parameters<typeof email>[0]) => shouldSync(parseGmailMessage(email({ plain: 'hola', ...o }))!, own);
  it('un correo directo de una persona en la bandeja de entrada: sí', () => { expect(decide({})).toEqual({ sync: true }); });
  it('promociones, redes, notificaciones, foros, spam, enviados, borradores y papelera: no', () => {
    for (const l of ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'SPAM', 'TRASH', 'SENT', 'DRAFT']) expect(decide({ labels: ['INBOX', l] })).toMatchObject({ sync: false });
    expect(decide({ labels: ['UNREAD'] })).toMatchObject({ sync: false, reason: 'not_inbox' });
  });
  it('boletines y respuestas automáticas: no', () => {
    expect(decide({ headers: { 'List-Unsubscribe': '<mailto:x>' } })).toMatchObject({ sync: false, reason: 'bulk' });
    expect(decide({ headers: { Precedence: 'bulk' } })).toMatchObject({ sync: false, reason: 'bulk' });
    expect(decide({ headers: { 'Auto-Submitted': 'auto-replied' } })).toMatchObject({ sync: false, reason: 'bulk' });
    expect(decide({ headers: { From: 'noreply@banco.com' } })).toMatchObject({ sync: false, reason: 'automated' });
    expect(decide({ headers: { From: 'Mail Delivery <mailer-daemon@google.com>' } })).toMatchObject({ sync: false });
  });
  it('lo que enviamos nosotros mismos: no', () => { expect(decide({ headers: { From: 'Ventas <VENTAS@arkos.co>' } })).toMatchObject({ sync: false, reason: 'own' }); });
});

describe('construir una respuesta', () => {
  const decodeRaw = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');
  it('cabeceras de hilo, asunto y cuerpo en UTF-8', () => {
    const txt = decodeRaw(buildRawEmail({ from: 'ventas@arkos.co', fromName: 'Arkos Ventas', to: 'ana@ejemplo.com', subject: 'Re: Cotización', body: 'Hola Ana, ¡con gusto!', inReplyTo: '<abc@mail.gmail.com>', references: '<x@y>' }));
    const [head, body] = txt.split('\r\n\r\n');
    expect(head).toContain('To: ana@ejemplo.com'); expect(head).toContain('From: Arkos Ventas <ventas@arkos.co>');
    expect(head).toContain('In-Reply-To: <abc@mail.gmail.com>'); expect(head).toContain('References: <x@y> <abc@mail.gmail.com>');
    expect(head).toContain(`Subject: =?UTF-8?B?${Buffer.from('Re: Cotización').toString('base64')}?=`);
    expect(head).toContain('charset="UTF-8"');
    expect(Buffer.from(body!.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Hola Ana, ¡con gusto!');
  });
  it('un asunto solo ASCII no se codifica y no hay cabeceras de hilo si no hay a qué responder', () => {
    const head = decodeRaw(buildRawEmail({ from: 'ventas@arkos.co', to: 'ana@ejemplo.com', subject: 'Re: Precio', body: 'x' })).split('\r\n\r\n')[0]!;
    expect(head).toContain('Subject: Re: Precio'); expect(head).not.toMatch(/In-Reply-To|References/);
  });
  it('NO permite inyectar cabeceras ni destinatarios extra', () => {
    const head = decodeRaw(buildRawEmail({ from: 'ventas@arkos.co', to: 'ana@ejemplo.com', subject: 'Hola\r\nBcc: espia@malo.com', body: 'x', inReplyTo: '<a@b>\r\nBcc: otro@malo.com' })).split('\r\n\r\n')[0]!;
    expect(head).not.toMatch(/^Bcc:/im);
    expect(head.split('\r\n').filter((l) => /^Subject:/.test(l))).toHaveLength(1);
    expect(() => buildRawEmail({ from: 'ventas@arkos.co', to: 'ana@ejemplo.com\r\nBcc: x@y.com', subject: 'x', body: 'x' })).toThrow('invalid_address');
    expect(() => buildRawEmail({ from: 'no', to: 'ana@ejemplo.com', subject: 'x', body: 'x' })).toThrow('invalid_address');
  });
});
