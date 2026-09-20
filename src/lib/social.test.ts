import { describe, expect, it } from 'vitest';
import { classifyMetaError } from './connections';
import { googleAuthUrl, isSocialPayload, metaAuthUrl, newNonce, parseSocialWebhook, redirectUri, signState, verifyState } from './social';

const PAGE = '100000000000001', PSID = '5500000000000001';
const fb = (messaging: unknown[], id = PAGE) => ({ object: 'page', entry: [{ id, time: 1, messaging }] });
const msg = (m: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1758375600000, message: m, ...extra });

describe('webhook de Messenger e Instagram', () => {
  it('mensaje de texto de Facebook', () => {
    const r = parseSocialWebhook(fb([msg({ mid: 'mid.1', text: 'Hola, quiero cotizar' })]));
    expect(r.kind).toBe('facebook');
    expect(r.messages).toEqual([{ kind: 'facebook', accountId: PAGE, thread: PSID, externalId: 'mid.1', msgKind: 'text', body: 'Hola, quiero cotizar', occurredAt: '2025-09-20T13:40:00.000Z', meta: {} }]);
  });
  it('Instagram se reconoce por el objeto', () => {
    const r = parseSocialWebhook({ object: 'instagram', entry: [{ id: '17841400000000001', messaging: [msg({ mid: 'm2', text: 'Hola' })].map((e) => ({ ...e, recipient: { id: '17841400000000001' } })) }] });
    expect(r.kind).toBe('instagram');
    expect(r.messages[0]).toMatchObject({ kind: 'instagram', accountId: '17841400000000001', thread: PSID });
  });
  it('adjuntos: una etiqueta comprensible, con la dirección solo si es https', () => {
    const r = parseSocialWebhook(fb([
      msg({ mid: 'a', attachments: [{ type: 'image', payload: { url: 'https://cdn.example/x.jpg' } }] }),
      msg({ mid: 'b', text: 'mira', attachments: [{ type: 'audio', payload: { url: 'http://inseguro/x' } }] }),
      msg({ mid: 'c', attachments: [{ type: 'image' }, { type: 'video' }] }),
    ]));
    expect(r.messages.map((m) => m.body)).toEqual(['[Imagen]', '[Audio] mira', '[2 adjuntos]']);
    expect(r.messages.every((m) => m.msgKind === 'media')).toBe(true);
    expect((r.messages[0]!.meta.attachments as { url: string | null }[])[0]!.url).toBe('https://cdn.example/x.jpg');
    expect((r.messages[1]!.meta.attachments as { url: string | null }[])[0]!.url).toBeNull();
  });
  it('los ecos (mensajes de la propia página), eliminados y reacciones NO son mensajes del cliente', () => {
    const r = parseSocialWebhook(fb([
      msg({ mid: 'e1', text: 'enviado por nosotros', is_echo: true }),
      { sender: { id: PAGE }, recipient: { id: PSID }, timestamp: 1, message: { mid: 'e2', text: 'yo' } },
      msg({ mid: 'd1', is_deleted: true }),
      { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, reaction: { mid: 'x', emoji: '👍' } },
      msg({ mid: 'ok', text: 'este sí' }),
    ]));
    expect(r.messages.map((m) => m.externalId)).toEqual(['ok']);
  });
  it('un botón (postback) llega como texto; sin identificador propio se genera uno estable', () => {
    const r = parseSocialWebhook(fb([{ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1758375600000, postback: { title: 'Ver catálogo', payload: 'CAT' } }]));
    expect(r.messages[0]).toMatchObject({ body: 'Ver catálogo', msgKind: 'text', externalId: `postback:${PSID}:1758375600000` });
  });
  it('estados: entregado (Facebook) y leído (Instagram)', () => {
    const r = parseSocialWebhook(fb([
      { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1758375600000, delivery: { mids: ['m1', 'm2'], watermark: 1 } },
      { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1758375600000, read: { mid: 'm1' } },
      { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, read: { watermark: 5 } },
    ]));
    expect(r.statuses.map((s) => `${s.status}:${s.externalId}`)).toEqual(['delivered:m1', 'delivered:m2', 'read:m1']);
    expect(r.messages).toEqual([]);
  });
  it('lo malformado se descarta sin fallar; WhatsApp no se confunde', () => {
    for (const bad of [null, 5, 'x', [], {}, { object: 'page' }, { object: 'page', entry: 'x' }, { object: 'page', entry: [null, { id: 'abc' }, { id: PAGE, messaging: 'x' }] }, fb([null, 5, msg({ text: 'sin mid' }), { sender: { id: 'abc' }, message: { mid: 'x', text: 'y' } }])]) {
      expect(parseSocialWebhook(bad).messages).toEqual([]);
    }
    expect(parseSocialWebhook({ object: 'whatsapp_business_account', entry: [] }).kind).toBeNull();
    expect(isSocialPayload({ object: 'page' })).toBe(true); expect(isSocialPayload({ object: 'instagram' })).toBe(true); expect(isSocialPayload({ object: 'whatsapp_business_account' })).toBe(false); expect(isSocialPayload(null)).toBe(false);
  });
  it('limita la cantidad y el tamaño, y quita caracteres de control', () => {
    const many = parseSocialWebhook(fb(Array.from({ length: 900 }, (_, i) => msg({ mid: `m${i}`, text: 'x' }))));
    expect(many.messages.length).toBe(500);
    expect(parseSocialWebhook(fb([msg({ mid: 'l', text: 'a'.repeat(9000) })])).messages[0]!.body.length).toBe(4096);
    expect(parseSocialWebhook(fb([msg({ mid: 'c', text: 'ho\u0000la\u0007' })])).messages[0]!.body).toBe('hola');
  });
  it('un mensaje fuera de la ventana permitida NO se toma por un problema de conexión', () => {
    expect(classifyMetaError({ code: 10, subcode: 2018278 })).toBeNull();
    expect(classifyMetaError({ code: 10, subcode: 2534022 })).toBeNull();
    expect(classifyMetaError({ code: 10 })?.state).toBe('needs_auth');
    expect(classifyMetaError({ code: 551 })).toBeNull();
  });
});

describe('autorización (OAuth)', () => {
  const S = { org: 'o1', user: 'u1', provider: 'meta' as const, nonce: 'n1', ts: 1_000_000 };
  it('la dirección de Meta pide solo lo necesario y no lleva el secreto', () => {
    const u = new URL(metaAuthUrl({ appId: '555', redirectUri: 'https://crm.test/api/connections/meta/callback', state: 'st' }));
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v24.0/dialog/oauth');
    expect(u.searchParams.get('client_id')).toBe('555'); expect(u.searchParams.get('state')).toBe('st'); expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')!.split(',')).toEqual(expect.arrayContaining(['pages_messaging', 'instagram_manage_messages', 'pages_show_list']));
    expect(u.search).not.toMatch(/secret/i);
  });
  it('la de Google pide acceso sin conexión y solo lectura + envío de Gmail', () => {
    const u = new URL(googleAuthUrl({ clientId: 'cid', redirectUri: 'https://crm.test/api/connections/google/callback', state: 'st' }));
    expect(u.searchParams.get('access_type')).toBe('offline'); expect(u.searchParams.get('prompt')).toBe('consent');
    const scopes = u.searchParams.get('scope')!.split(' ');
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.readonly'); expect(scopes).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(scopes.some((x) => /gmail\.(modify|compose)|mail\.google\.com/.test(x))).toBe(false);   // no se pide más de lo necesario
  });
  it('dirección de retorno', () => { expect(redirectUri('https://crm.test/', 'google')).toBe('https://crm.test/api/connections/google/callback'); });
  it('estado firmado: ida y vuelta, y rechaza manipulación, otra clave o caducidad', () => {
    const tok = signState(S, 'secreto-largo');
    expect(verifyState(tok, 'secreto-largo', S.ts + 1000)).toEqual(S);
    expect(verifyState(tok, 'otro-secreto', S.ts + 1000)).toBeNull();
    const [b, m] = tok.split('.'); const forged = Buffer.from(JSON.stringify({ ...S, org: 'o2' })).toString('base64url');
    expect(verifyState(`${forged}.${m}`, 'secreto-largo', S.ts + 1000)).toBeNull();
    expect(verifyState(`${b}.${m}x`, 'secreto-largo', S.ts + 1000)).toBeNull();
    expect(verifyState(tok, 'secreto-largo', S.ts + 11 * 60_000)).toBeNull();               // caducó
    expect(verifyState(tok, 'secreto-largo', S.ts - 5 * 60_000)).toBeNull();                // del futuro
    for (const bad of [null, undefined, '', 'sin-punto', '.', 'a.b']) expect(verifyState(bad, 'secreto-largo', S.ts)).toBeNull();
    expect(verifyState(tok, undefined, S.ts)).toBeNull();
    expect(newNonce()).not.toBe(newNonce());
  });
});
