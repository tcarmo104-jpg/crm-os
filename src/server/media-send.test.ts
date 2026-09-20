import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { sendSocialAttachment } from './meta-social';
import { sendGmailReply } from './gmail';
import { sendWhatsAppMedia } from './whatsapp';

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }
function fake(handler: (c: Call) => { status?: number; body: unknown } | 'network') {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const c: Call = { url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body };
    calls.push(c);
    const r = handler(c);
    if (r === 'network') throw new Error('ECONNRESET');
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const text = async (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : v ? Buffer.from(await v.arrayBuffer()).toString('latin1') : null);

describe('WhatsApp: subir el archivo y enviarlo', () => {
  const base = { phoneNumberId: '109876543210', token: 'TOKEN-WA', to: '573001110000', bytes: BYTES, mime: 'image/jpeg', fileName: 'foto.jpg' };
  it('paso 1: sube el archivo (campos oficiales); paso 2: envía el mensaje con el id devuelto y el pie de foto', async () => {
    const f = fake((c) => (c.url.endsWith('/media') ? { body: { id: 'MEDIA1' } } : { body: { messages: [{ id: 'wamid.out1' }] } }));
    expect(await sendWhatsAppMedia({ ...base, type: 'image', caption: 'Mira', fetchImpl: f.fetchImpl })).toEqual({ ok: true, externalId: 'wamid.out1' });
    expect(f.calls).toHaveLength(2);
    const up = f.calls[0]!; const form = up.body as FormData;
    expect(up.url).toMatch(/\/109876543210\/media$/); expect(up.headers.Authorization).toBe('Bearer TOKEN-WA'); expect(up.headers['Content-Type']).toBeUndefined();   // el «boundary» lo pone fetch
    expect(form.get('messaging_product')).toBe('whatsapp'); expect(form.get('type')).toBe('image/jpeg');
    const file = form.get('file') as File; expect(file.name).toBe('foto.jpg'); expect(file.type).toBe('image/jpeg'); expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(BYTES))).toBe(true);
    const msg = JSON.parse(String(f.calls[1]!.body));
    expect(f.calls[1]!.url).toMatch(/\/109876543210\/messages$/);
    expect(msg).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '573001110000', type: 'image', image: { id: 'MEDIA1', caption: 'Mira' } });
  });
  it('documento con nombre; audio sin pie de foto', async () => {
    const f = fake((c) => (c.url.endsWith('/media') ? { body: { id: 'M9' } } : { body: { messages: [{ id: 'w2' }] } }));
    await sendWhatsAppMedia({ ...base, type: 'document', mime: 'application/pdf', fileName: 'plano cliente.pdf', caption: 'Plano', fetchImpl: f.fetchImpl });
    expect(JSON.parse(String(f.calls[1]!.body)).document).toEqual({ id: 'M9', caption: 'Plano', filename: 'plano cliente.pdf' });
    const g = fake((c) => (c.url.endsWith('/media') ? { body: { id: 'M8' } } : { body: { messages: [{ id: 'w3' }] } }));
    await sendWhatsAppMedia({ ...base, type: 'audio', mime: 'audio/ogg', fileName: 'v.ogg', caption: 'no', fetchImpl: g.fetchImpl });
    expect(JSON.parse(String(g.calls[1]!.body)).audio).toEqual({ id: 'M8' });
  });
  it('si falla la SUBIDA no se envía nada y el rechazo es definitivo (se puede reintentar sin duplicar)', async () => {
    for (const h of [() => 'network' as const, () => ({ status: 503, body: {} }), () => ({ status: 200, body: {} })]) {
      const f = fake(h);
      const r = await sendWhatsAppMedia({ ...base, type: 'image', fetchImpl: f.fetchImpl });
      expect(r).toMatchObject({ ok: false, definitive: true, code: 'upload_failed' });
      expect(f.calls.every((c) => c.url.endsWith('/media'))).toBe(true);
    }
  });
  it('un rechazo de Meta al subir (formato no admitido) llega en español y sin el token', async () => {
    const f = fake(() => ({ status: 400, body: { error: { code: 131053, message: `Media upload error EAAB1234567890abcdefgh`, error_data: { details: 'mime mismatch' } } } }));
    const r = await sendWhatsAppMedia({ ...base, type: 'image', fetchImpl: f.fetchImpl });
    expect(r).toMatchObject({ ok: false, definitive: true, code: '131053' }); expect(JSON.stringify(r)).not.toContain('EAAB1234');
  });
  it('si el mensaje final es de resultado DESCONOCIDO (Meta caído) no se reenvía', async () => {
    const f = fake((c) => (c.url.endsWith('/media') ? { body: { id: 'M1' } } : { status: 503, body: {} }));
    expect(await sendWhatsAppMedia({ ...base, type: 'image', fetchImpl: f.fetchImpl })).toMatchObject({ ok: false, definitive: false });
  });
});

describe('Messenger / Instagram: archivo en la misma petición', () => {
  const base = { token: 'PAGE-TOKEN', to: '5500000000000001', bytes: BYTES, mime: 'image/png', fileName: 'muestra.png' };
  it('envía multipart con destinatario, tipo y «filedata»; el texto NO va mezclado', async () => {
    const f = fake(() => ({ body: { recipient_id: '5500000000000001', message_id: 'mid.out.1' } }));
    expect(await sendSocialAttachment({ ...base, type: 'image', fetchImpl: f.fetchImpl })).toEqual({ ok: true, externalId: 'mid.out.1' });
    const c = f.calls[0]!; const form = c.body as FormData;
    expect(c.url).toMatch(/\/me\/messages$/); expect(c.headers.Authorization).toBe('Bearer PAGE-TOKEN'); expect(c.headers['Content-Type']).toBeUndefined();
    expect(JSON.parse(String(form.get('recipient')))).toEqual({ id: '5500000000000001' });
    expect(JSON.parse(String(form.get('message')))).toEqual({ attachment: { type: 'image', payload: { is_reusable: false } } });
    expect(form.get('messaging_type')).toBe('RESPONSE'); expect(await text(form.get('filedata'))).toBe(Buffer.from(BYTES).toString('latin1')); expect((form.get('filedata') as File).name).toBe('muestra.png');
  });
  it('rechazo definitivo (fuera de ventana) con mensaje comprensible; red o 5xx = desconocido', async () => {
    const w = await sendSocialAttachment({ ...base, type: 'file', fetchImpl: fake(() => ({ status: 400, body: { error: { code: 10, error_subcode: 2018278, message: 'x' } } })).fetchImpl });
    expect(w).toMatchObject({ ok: false, definitive: true, code: '10', subcode: '2018278' }); expect((w as { message: string }).message).toMatch(/24 horas/);
    expect(await sendSocialAttachment({ ...base, type: 'image', fetchImpl: fake(() => 'network').fetchImpl })).toMatchObject({ ok: false, definitive: false });
    expect(await sendSocialAttachment({ ...base, type: 'image', fetchImpl: fake(() => ({ status: 503, body: {} })).fetchImpl })).toMatchObject({ ok: false, definitive: false });
    expect(await sendSocialAttachment({ ...base, to: 'no-valido', type: 'image', fetchImpl: fake(() => ({ body: {} })).fetchImpl })).toMatchObject({ definitive: true, code: 'bad_recipient' });
  });
});

describe('Gmail: responder con varios adjuntos', () => {
  const base = { refreshToken: 'R', app: { clientId: 'gid', clientSecret: 'gsecret' }, from: 'ventas@arkos.co', to: 'ana@ejemplo.com', body: 'Adjunto los planos',
    replyMeta: { message_id: '<orig@mail>', subject: 'Cotización', gmail_thread_id: 'th9' }, attachments: [{ fileName: 'plano.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.7 hola') }, { fileName: 'foto.png', mime: 'image/png', bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) }] };
  it('renueva el acceso y usa la carga multipart (metadatos con el hilo + el correo completo con sus archivos)', async () => {
    const f = fake((c) => (c.url.includes('oauth2') ? { body: { access_token: 'FRESH' } } : { body: { id: 'gsent1' } }));
    expect(await sendGmailReply({ ...base, fetchImpl: f.fetchImpl })).toEqual({ ok: true, externalId: 'gsent1' });
    const send = f.calls[1]!;
    expect(new URL(send.url).pathname).toBe('/upload/gmail/v1/users/me/messages/send'); expect(new URL(send.url).searchParams.get('uploadType')).toBe('multipart');
    expect(send.headers.Authorization).toBe('Bearer FRESH'); expect(send.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/);
    const body = Buffer.from(send.body as Uint8Array).toString('utf8');
    expect(body).toContain('{"threadId":"th9"}'); expect(body).toContain('Content-Type: message/rfc822');
    expect(body).toContain('To: ana@ejemplo.com'); expect(body).toContain('In-Reply-To: <orig@mail>'); expect(body).toContain('name="plano.pdf"'); expect(body).toContain('name="foto.png"');
    expect(body).toContain('Subject: Re: Cotización'.includes('ó') ? `Subject: =?UTF-8?B?${Buffer.from('Re: Cotización').toString('base64')}?=` : 'Subject: Re: Cotización');
  });
  it('sin adjuntos sigue usando el envío simple de siempre (no cambia lo que ya funcionaba)', async () => {
    const f = fake((c) => (c.url.includes('oauth2') ? { body: { access_token: 'FRESH' } } : { body: { id: 'g2' } }));
    await sendGmailReply({ ...base, attachments: undefined, fetchImpl: f.fetchImpl });
    expect(f.calls[1]!.url).toMatch(/\/gmail\/v1\/users\/me\/messages\/send$/); expect(JSON.parse(String(f.calls[1]!.body)).threadId).toBe('th9');
  });
  it('acceso revocado: no envía; destinatario inválido o caída: respuestas correctas', async () => {
    const dead = fake(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    expect(await sendGmailReply({ ...base, fetchImpl: dead.fetchImpl })).toMatchObject({ definitive: true, code: 'invalid_grant' }); expect(dead.calls).toHaveLength(1);
    const ok = (status: number) => fake((c) => (c.url.includes('oauth2') ? { body: { access_token: 'F' } } : { status, body: {} }));
    expect(await sendGmailReply({ ...base, to: 'no-es-correo', fetchImpl: ok(200).fetchImpl })).toMatchObject({ definitive: true, code: 'bad_recipient' });
    expect(await sendGmailReply({ ...base, fetchImpl: ok(503).fetchImpl })).toMatchObject({ ok: false, definitive: false });
  });
});
