import { describe, expect, it } from 'vitest';
import { parseWebhook } from './meta';
import { parseSocialWebhook } from './social';
import { parseGmailMessage, type GmailMessage } from './gmail';

const wa = (m: Record<string, unknown>) => parseWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
  metadata: { phone_number_id: '109876543210' }, contacts: [{ wa_id: '573001110000', profile: { name: 'Ana' } }],
  messages: [{ from: '573001110000', id: 'wamid.1', timestamp: '1758375600', ...m }] } }] }] }).messages[0]!;

describe('WhatsApp: adjuntos en formato común', () => {
  it('imagen con pie de foto: conserva el texto y los datos de siempre, y añade el adjunto', () => {
    const m = wa({ type: 'image', image: { id: 'MID1', mime_type: 'image/jpeg', sha256: 'a'.repeat(44), caption: 'Mira esto' } });
    expect(m.body).toBe('[Imagen] Mira esto'); expect(m.kind).toBe('media'); expect(m.meta).toEqual({ type: 'image', media_id: 'MID1', mime_type: 'image/jpeg' });
    expect(m.attachments).toEqual([{ kind: 'image', mime_type: 'image/jpeg', file_name: null, is_voice: false, source: { media_id: 'MID1', sha256: 'a'.repeat(44) }, meta: {} }]);
  });
  it('documento con nombre, video, audio y nota de voz, sticker animado', () => {
    expect(wa({ type: 'document', document: { id: 'D1', filename: 'plano cliente.pdf', mime_type: 'application/pdf' } }).attachments![0]).toMatchObject({ kind: 'document', file_name: 'plano cliente.pdf', mime_type: 'application/pdf', source: { media_id: 'D1' } });
    expect(wa({ type: 'video', video: { id: 'V1', mime_type: 'video/mp4' } }).attachments![0]).toMatchObject({ kind: 'video' });
    expect(wa({ type: 'audio', audio: { id: 'A1', mime_type: 'audio/ogg; codecs=opus', voice: true } }).attachments![0]).toMatchObject({ kind: 'audio', is_voice: true, mime_type: 'audio/ogg; codecs=opus' });
    expect(wa({ type: 'audio', audio: { id: 'A2', mime_type: 'audio/mpeg' } }).attachments![0]!.is_voice).toBe(false);
    expect(wa({ type: 'sticker', sticker: { id: 'S1', mime_type: 'image/webp', animated: true } }).attachments![0]).toMatchObject({ kind: 'sticker', meta: { animated: true } });
  });
  it('un medio sin identificador no genera adjunto (nada que descargar)', () => { expect(wa({ type: 'image', image: { mime_type: 'image/jpeg' } }).attachments).toEqual([]); });
  it('ubicación con coordenadas y contactos compartidos', () => {
    expect(wa({ type: 'location', location: { latitude: 6.2442, longitude: -75.5812, name: 'Oficina', address: 'Calle 10 # 5-20' } }).attachments).toEqual([{ kind: 'location', meta: { lat: 6.2442, lng: -75.5812, name: 'Oficina', address: 'Calle 10 # 5-20' } }]);
    expect(wa({ type: 'location', location: { latitude: 999, longitude: 0 } }).attachments).toEqual([]);
    expect(wa({ type: 'location', location: { name: 'sin coordenadas' } }).attachments).toEqual([]);
    const c = wa({ type: 'contacts', contacts: [{ name: { formatted_name: 'Carlos Ruiz' }, phones: [{ phone: '+57 300 111 2233' }] }, { name: { formatted_name: 'Luz' } }] });
    expect(c.attachments).toEqual([{ kind: 'contact', meta: { name: 'Carlos Ruiz', phone: '+57 300 111 2233' } }, { kind: 'contact', meta: { name: 'Luz' } }]);
  });
  it('un mensaje de texto no lleva adjuntos', () => { expect(wa({ type: 'text', text: { body: 'hola' } }).attachments).toBeUndefined(); });
});

const PAGE = '100000000000001', PSID = '5500000000000001';
const fb = (attachments: unknown[]) => parseSocialWebhook({ object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1758375600000, message: { mid: 'mid.1', attachments } }] }] }).messages[0]!;

describe('Messenger e Instagram: adjuntos en formato común', () => {
  it('imagen, audio, video y archivo con enlace https', () => {
    const m = fb([{ type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/a.jpg' } }, { type: 'audio', payload: { url: 'https://cdn.fbsbx.com/a.mp4' } }, { type: 'video', payload: { url: 'https://cdn.fbsbx.com/v.mp4' } }, { type: 'file', payload: { url: 'https://cdn.fbsbx.com/f.pdf' }, title: 'plano.pdf' }]);
    expect(m.attachments!.map((a) => a.kind)).toEqual(['image', 'audio', 'video', 'document']);
    expect(m.attachments![0]!.source).toEqual({ url: 'https://scontent.xx.fbcdn.net/a.jpg' }); expect(m.attachments![3]!.meta).toMatchObject({ title: 'plano.pdf' });
    expect(m.meta.attachments).toHaveLength(4);                                    // compatibilidad: sigue guardándose como antes
  });
  it('un enlace que no es https no se descarga; una ubicación trae coordenadas; historias y enlaces se deciden al bajar', () => {
    expect(fb([{ type: 'image', payload: { url: 'http://inseguro/x.jpg' } }]).attachments![0]).toMatchObject({ kind: 'image', source: {} });
    expect(fb([{ type: 'location', title: 'Aquí', payload: { coordinates: { lat: 6.2, long: -75.5 } } }]).attachments).toEqual([{ kind: 'location', meta: { lat: 6.2, lng: -75.5, name: 'Aquí' } }]);
    expect(fb([{ type: 'location', payload: {} }]).attachments).toEqual([]);
    expect(fb([{ type: 'story_mention', payload: { url: 'https://lookaside.fbsbx.com/s' } }]).attachments![0]).toMatchObject({ kind: 'file', source: { url: 'https://lookaside.fbsbx.com/s' }, meta: { channel_type: 'story_mention' } });
    expect(fb([{ type: 'fallback', title: 'Enlace' }]).attachments![0]).toMatchObject({ kind: 'unsupported', source: {} });
  });
  it('máximo 5 adjuntos por mensaje', () => { expect(fb(Array.from({ length: 9 }, () => ({ type: 'image', payload: { url: 'https://cdn.fbsbx.com/a' } }))).attachments).toHaveLength(5); });
});

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const email = (parts: unknown[]): GmailMessage => ({ id: 'a0b1c2d3e4f50001', threadId: 't', labelIds: ['INBOX'], internalDate: '1758375600000', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'Ana <ana@ejemplo.com>' }, { name: 'Subject', value: 'Planos' }],
  parts: [{ mimeType: 'text/plain', body: { data: b64('Adjunto planos') } }, ...(parts as never[])] } });

describe('Gmail: adjuntos en formato común', () => {
  it('lista los archivos con su identificador, nombre, tipo, tamaño y si van dentro del cuerpo', () => {
    const e = parseGmailMessage(email([
      { mimeType: 'application/pdf', filename: 'plano.pdf', body: { attachmentId: 'ATT1', size: 245000 }, headers: [{ name: 'Content-Disposition', value: 'attachment; filename="plano.pdf"' }] },
      { mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'ATT2', size: 3000 }, headers: [{ name: 'Content-Disposition', value: 'inline; filename="logo.png"' }] },
    ]))!;
    expect(e.attachments).toBe(2);
    expect(e.files).toEqual([{ fileName: 'plano.pdf', mime: 'application/pdf', size: 245000, attachmentId: 'ATT1', inline: false }, { fileName: 'logo.png', mime: 'image/png', size: 3000, attachmentId: 'ATT2', inline: true }]);
  });
  it('lo que no tiene identificador de descarga no se lista; sin adjuntos, lista vacía; tope de 20', () => {
    expect(parseGmailMessage(email([{ mimeType: 'application/pdf', filename: 'x.pdf', body: { size: 5 } }]))!.files).toEqual([]);
    expect(parseGmailMessage(email([]))!.files).toEqual([]);
    expect(parseGmailMessage(email(Array.from({ length: 30 }, (_, i) => ({ mimeType: 'application/pdf', filename: `f${i}.pdf`, body: { attachmentId: `A${i}`, size: 1 } }))))!.files).toHaveLength(20);
  });
});
