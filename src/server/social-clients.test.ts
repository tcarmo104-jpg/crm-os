import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { exchangeMetaCode, extendMetaToken, fetchContactName, listPages, pageSubscription, sendSocial, subscribePage } from './meta-social';
import { exchangeGoogleCode, getGmailMessage, listHistory, refreshGoogleToken, sendGmailReply } from './gmail';

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
function fake(handler: (c: Call) => { status?: number; body: unknown } | 'network') {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const c: Call = { url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') };
    calls.push(c);
    const r = handler(c);
    if (r === 'network') throw new Error('ECONNRESET');
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const APP = { appId: '5550001', appSecret: 'meta-secret-xyz-secret' };
const GAPP = { clientId: 'gid', clientSecret: 'GOCSPX-secret' };

describe('inicio de sesión con Meta', () => {
  it('el secreto viaja en el CUERPO (nunca en la dirección) y sin encabezado de autorización', async () => {
    const f = fake(() => ({ body: { access_token: 'T' } }));
    await exchangeMetaCode('CODE', 'https://crm.test/cb', APP, { fetchImpl: f.fetchImpl });
    await extendMetaToken('SHORT', APP, { fetchImpl: f.fetchImpl });
    for (const c of f.calls) { expect(c.url).not.toContain('secret'); expect(c.method).toBe('POST'); expect(c.headers.Authorization).toBeUndefined(); expect(c.body).toContain('client_secret=meta-secret-xyz-secret'); }
    expect(f.calls[0]!.body).toContain('code=CODE'); expect(f.calls[1]!.body).toContain('grant_type=fb_exchange_token');
  });
  it('lista páginas con su token y su Instagram; descarta las que vienen incompletas', async () => {
    const f = fake(() => ({ body: { data: [
      { id: '100000000000001', name: 'A', access_token: 'PT1', instagram_business_account: { id: '17841400000000001', username: 'a_ig' } },
      { id: '100000000000002', name: 'B', access_token: 'PT2' },
      { id: 'no-numerico', name: 'C', access_token: 'PT3' }, { id: '100000000000004', name: 'D' }] } }));
    const r = await listPages('UT', { fetchImpl: f.fetchImpl });
    expect(r.ok && r.data.map((p) => [p.id, p.ig?.username ?? null])).toEqual([['100000000000001', 'a_ig'], ['100000000000002', null]]);
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer UT');
    expect(f.calls[0]!.url).not.toContain('UT');
  });
  it('un error de permisos al listar páginas llega clasificado', async () => {
    const r = await listPages('UT', { fetchImpl: fake(() => ({ status: 400, body: { error: { code: 200, message: 'permiso' } } })).fetchImpl });
    expect(r).toMatchObject({ ok: false, state: 'needs_auth', code: '200' });
  });
});

describe('suscripción de la página y perfil del contacto', () => {
  it('detecta si nuestra app recibe «messages» y la suscribe con los campos justos', async () => {
    const yes = fake(() => ({ body: { data: [{ id: '5550001', subscribed_fields: ['messages', 'message_reads'] }] } }));
    expect(await pageSubscription('100000000000001', 'T', '5550001', { fetchImpl: yes.fetchImpl })).toEqual({ ok: true, data: true });
    const other = fake(() => ({ body: { data: [{ id: '999', subscribed_fields: ['messages'] }] } }));
    expect(await pageSubscription('100000000000001', 'T', '5550001', { fetchImpl: other.fetchImpl })).toEqual({ ok: true, data: false });
    const noField = fake(() => ({ body: { data: [{ id: '5550001', subscribed_fields: ['feed'] }] } }));
    expect(await pageSubscription('100000000000001', 'T', '5550001', { fetchImpl: noField.fetchImpl })).toEqual({ ok: true, data: false });
    const f = fake(() => ({ body: { success: true } }));
    await subscribePage('100000000000001', 'T', { fetchImpl: f.fetchImpl });
    expect(f.calls[0]!.body).toContain('subscribed_fields=messages%2Cmessaging_postbacks%2Cmessage_deliveries%2Cmessage_reads');
    expect((await subscribePage('abc', 'T', { fetchImpl: f.fetchImpl })).ok).toBe(false);
  });
  it('el nombre del contacto es de mejor esfuerzo: si Meta falla devuelve null', async () => {
    expect(await fetchContactName('facebook', '5500000000000001', 'T', { fetchImpl: fake(() => ({ body: { name: ' Ana Gómez ' } })).fetchImpl })).toBe('Ana Gómez');
    expect(await fetchContactName('instagram', '5500000000000001', 'T', { fetchImpl: fake(() => ({ body: { username: 'ana_g' } })).fetchImpl })).toBe('ana_g');
    expect(await fetchContactName('facebook', '5500000000000001', 'T', { fetchImpl: fake(() => 'network').fetchImpl })).toBeNull();
    expect(await fetchContactName('facebook', 'abc', 'T', { fetchImpl: fake(() => ({ body: {} })).fetchImpl })).toBeNull();
  });
});

describe('enviar por Messenger / Instagram', () => {
  it('envía a «me/messages» con el token de la página, dentro de la ventana de respuesta', async () => {
    const f = fake(() => ({ body: { recipient_id: '5500000000000001', message_id: 'mid.9' } }));
    expect(await sendSocial({ token: 'PT', to: '5500000000000001', body: 'Hola', fetchImpl: f.fetchImpl })).toEqual({ ok: true, externalId: 'mid.9' });
    const c = f.calls[0]!;
    expect(c.url).toMatch(/\/me\/messages$/); expect(c.headers.Authorization).toBe('Bearer PT');
    expect(JSON.parse(c.body)).toEqual({ recipient: { id: '5500000000000001' }, messaging_type: 'RESPONSE', message: { text: 'Hola' } });
  });
  it('rechazo definitivo con mensaje comprensible; red o 5xx = desconocido (no se reintenta)', async () => {
    const win = await sendSocial({ token: 'PT', to: '5500000000000001', body: 'x', fetchImpl: fake(() => ({ status: 400, body: { error: { code: 10, error_subcode: 2018278, message: 'x' } } })).fetchImpl });
    expect(win).toMatchObject({ ok: false, definitive: true, code: '10', subcode: '2018278' });
    expect((win as { message: string }).message).toMatch(/24 horas/);
    const tok = await sendSocial({ token: 'PT', to: '5500000000000001', body: 'x', fetchImpl: fake(() => ({ status: 400, body: { error: { code: 190, message: 'EAAB1234567890abcdefgh' } } })).fetchImpl });
    expect((tok as { message: string }).message).toMatch(/Vuelve a autorizarla/); expect(JSON.stringify(tok)).not.toContain('EAAB1234');
    expect(await sendSocial({ token: 'PT', to: '5500000000000001', body: 'x', fetchImpl: fake(() => ({ status: 503, body: {} })).fetchImpl })).toMatchObject({ ok: false, definitive: false });
    expect(await sendSocial({ token: 'PT', to: '5500000000000001', body: 'x', fetchImpl: fake(() => 'network').fetchImpl })).toMatchObject({ ok: false, definitive: false });
    expect(await sendSocial({ token: 'PT', to: 'no-valido', body: 'x', fetchImpl: fake(() => ({ body: {} })).fetchImpl })).toMatchObject({ ok: false, definitive: true, code: 'bad_recipient' });
  });
  it('sin identificador de mensaje en la respuesta no se da por enviado', async () => {
    expect(await sendSocial({ token: 'PT', to: '5500000000000001', body: 'x', fetchImpl: fake(() => ({ body: {} })).fetchImpl })).toMatchObject({ ok: false, definitive: false });
  });
});

describe('Google', () => {
  it('cambiar el código y renovar el acceso: el secreto va en el cuerpo, no en la dirección', async () => {
    const f = fake(() => ({ body: { access_token: 'a', refresh_token: 'r' } }));
    await exchangeGoogleCode('C', 'https://crm.test/cb', GAPP, { fetchImpl: f.fetchImpl });
    await refreshGoogleToken('R', GAPP, { fetchImpl: f.fetchImpl });
    for (const c of f.calls) { expect(c.url).toBe('https://oauth2.googleapis.com/token'); expect(c.body).toContain('client_secret=GOCSPX-secret'); }
    expect(f.calls[0]!.body).toContain('grant_type=authorization_code'); expect(f.calls[1]!.body).toContain('grant_type=refresh_token');
  });
  it('acceso revocado (invalid_grant) → «Token expirado»; permisos insuficientes → «Requiere autorización»; caída/límite → transitorio', async () => {
    expect(await refreshGoogleToken('R', GAPP, { fetchImpl: fake(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } })).fetchImpl })).toMatchObject({ ok: false, kind: 'rejected', state: 'token_expired', code: 'invalid_grant' });
    expect(await getGmailMessage('A', '18f3a9c2b4d5e6f7', { fetchImpl: fake(() => ({ status: 401, body: { error: { code: 401, message: 'x', status: 'UNAUTHENTICATED' } } })).fetchImpl })).toMatchObject({ state: 'token_expired' });
    expect(await getGmailMessage('A', '18f3a9c2b4d5e6f7', { fetchImpl: fake(() => ({ status: 403, body: { error: { code: 403, message: 'Insufficient Permission', status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] } } })).fetchImpl })).toMatchObject({ state: 'needs_auth' });
    expect(await getGmailMessage('A', '18f3a9c2b4d5e6f7', { fetchImpl: fake(() => ({ status: 429, body: {} })).fetchImpl })).toMatchObject({ kind: 'transient', state: null });
    expect(await getGmailMessage('A', '18f3a9c2b4d5e6f7', { fetchImpl: fake(() => 'network').fetchImpl })).toMatchObject({ kind: 'transient', code: 'network' });
  });
  it('el historial: pide solo mensajes agregados a la bandeja y pasa la página', async () => {
    const f = fake(() => ({ body: { history: [] } }));
    await listHistory('A', '123', { fetchImpl: f.fetchImpl, pageToken: 'PT' });
    const u = new URL(f.calls[0]!.url);
    expect(u.searchParams.get('startHistoryId')).toBe('123'); expect(u.searchParams.get('historyTypes')).toBe('messageAdded'); expect(u.searchParams.get('labelId')).toBe('INBOX'); expect(u.searchParams.get('pageToken')).toBe('PT');
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer A'); expect(f.calls[0]!.url).not.toMatch(/access_token/);
  });
  it('un identificador de correo que no sea hexadecimal NO sale a la red', async () => {
    const f = fake(() => ({ body: {} }));
    for (const bad of ['../../settings', '', 'abc def', "1'; drop", 'zzzzzzzz']) expect(await getGmailMessage('A', bad, { fetchImpl: f.fetchImpl })).toMatchObject({ ok: false, code: 'bad_id' });
    expect(f.calls).toHaveLength(0);
    await getGmailMessage('A', '18f3a9c2b4d5e6f7', { fetchImpl: f.fetchImpl });
    expect(new URL(f.calls[0]!.url).pathname).toBe('/gmail/v1/users/me/messages/18f3a9c2b4d5e6f7');
  });
  it('responder: renueva el acceso, envía en su hilo y devuelve el id; con el acceso revocado NO envía nada', async () => {
    const f = fake((c) => c.url.includes('oauth2') ? { body: { access_token: 'FRESH' } } : { body: { id: 'sent-1' } });
    const r = await sendGmailReply({ refreshToken: 'R', app: GAPP, from: 'ventas@arkos.co', to: 'ana@ejemplo.com', body: 'Hola', replyMeta: { message_id: '<a@b>', subject: 'Precio', gmail_thread_id: 't9' }, fetchImpl: f.fetchImpl });
    expect(r).toEqual({ ok: true, externalId: 'sent-1' });
    const send = f.calls[1]!;
    expect(send.headers.Authorization).toBe('Bearer FRESH'); expect(JSON.parse(send.body).threadId).toBe('t9');
    expect(Buffer.from(JSON.parse(send.body).raw, 'base64url').toString()).toContain('In-Reply-To: <a@b>');
    const dead = fake(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    const r2 = await sendGmailReply({ refreshToken: 'R', app: GAPP, from: 'ventas@arkos.co', to: 'ana@ejemplo.com', body: 'x', replyMeta: {}, fetchImpl: dead.fetchImpl });
    expect(r2).toMatchObject({ ok: false, definitive: true, code: 'invalid_grant' }); expect(dead.calls).toHaveLength(1);
  });
  it('un destinatario inválido no llega a Google; una caída al enviar es «desconocido» (no se reenvía)', async () => {
    const f = fake((c) => c.url.includes('oauth2') ? { body: { access_token: 'FRESH' } } : { body: {} });
    expect(await sendGmailReply({ refreshToken: 'R', app: GAPP, from: 'ventas@arkos.co', to: 'no-es-correo', body: 'x', replyMeta: {}, fetchImpl: f.fetchImpl })).toMatchObject({ definitive: true, code: 'bad_recipient' });
    const f2 = fake((c) => c.url.includes('oauth2') ? { body: { access_token: 'FRESH' } } : { status: 503, body: {} });
    expect(await sendGmailReply({ refreshToken: 'R', app: GAPP, from: 'ventas@arkos.co', to: 'ana@ejemplo.com', body: 'x', replyMeta: {}, fetchImpl: f2.fetchImpl })).toMatchObject({ ok: false, definitive: false });
  });
});
