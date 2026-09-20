import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
import { graphBase, sendWhatsApp } from './whatsapp';

const TOKEN = 'EAAB-token-secreto-abcdefghijklmnop';
const base = { phoneNumberId: '109876543210', token: TOKEN, to: '573001112233', kind: 'text' as const, body: 'Hola' };
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

afterEach(() => { delete process.env.META_GRAPH_BASE; delete process.env.META_GRAPH_VERSION; });

describe('envío por la API de Meta', () => {
  it('éxito: devuelve el wamid y llama a la URL, cabeceras y cuerpo correctos', async () => {
    const f = reply(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.OK' }] });
    const r = await sendWhatsApp({ ...base, fetchImpl: f as never });
    expect(r).toEqual({ ok: true, externalId: 'wamid.OK' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v24.0/109876543210/messages');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toMatchObject({ messaging_product: 'whatsapp', to: '573001112233', type: 'text', text: { body: 'Hola' } });
  });
  it('plantilla: envía nombre, idioma y parámetros', async () => {
    const f = reply(200, { messages: [{ id: 'wamid.T' }] });
    await sendWhatsApp({ ...base, kind: 'template', templateName: 'seguimiento', templateLanguage: 'es', templateParams: ['Carlos', 'A-1'], fetchImpl: f as never });
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.type).toBe('template');
    expect(body.template.components[0].parameters).toHaveLength(2);
  });
  it('la versión y la base se pueden configurar', () => {
    process.env.META_GRAPH_BASE = 'http://localhost:9999/';
    process.env.META_GRAPH_VERSION = 'v99.0';
    expect(graphBase()).toBe('http://localhost:9999/v99.0');
  });
  it('rechazo definitivo (4xx de Meta): se sabe que NO salió, con el motivo en español', async () => {
    const r = await sendWhatsApp({ ...base, fetchImpl: reply(400, { error: { message: '(#131047) Re-engagement message', type: 'OAuthException', code: 131047 } }) as never });
    expect(r).toMatchObject({ ok: false, definitive: true, code: '131047' });
    expect((r as { message: string }).message).toMatch(/24 horas/);
  });
  it('token vencido (401 / código 190) es definitivo y explica cómo arreglarlo', async () => {
    const r = await sendWhatsApp({ ...base, fetchImpl: reply(401, { error: { message: 'Invalid OAuth access token', code: 190 } }) as never });
    expect(r).toMatchObject({ ok: false, definitive: true, code: '190' });
    expect((r as { message: string }).message).toMatch(/Configuración → Conexiones/);
  });
  it('resultado DESCONOCIDO (5xx, red, 200 sin id, tiempo agotado): NO es definitivo → no se reenvía solo', async () => {
    expect(await sendWhatsApp({ ...base, fetchImpl: reply(503, { error: {} }) as never })).toMatchObject({ ok: false, definitive: false });
    expect(await sendWhatsApp({ ...base, fetchImpl: reply(200, { unexpected: true }) as never })).toMatchObject({ ok: false, definitive: false });
    expect(await sendWhatsApp({ ...base, fetchImpl: vi.fn(async () => { throw new Error('ECONNRESET'); }) as never })).toMatchObject({ ok: false, definitive: false });
    const hang = vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('abort')))));
    expect(await sendWhatsApp({ ...base, timeoutMs: 20, fetchImpl: hang as never })).toMatchObject({ ok: false, definitive: false });
  });
  it('el token NUNCA aparece en el resultado, aunque Meta lo repita en el error o falle la red', async () => {
    const r = await sendWhatsApp({ ...base, fetchImpl: reply(400, { error: { message: `bad token ${TOKEN} inválido`, code: 100 } }) as never });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).toContain('[oculto]');
    const det = await sendWhatsApp({ ...base, fetchImpl: reply(400, { error: { code: 100, error_data: { details: `Token ${TOKEN}` } } }) as never });
    expect(JSON.stringify(det)).not.toContain(TOKEN);
    const net = await sendWhatsApp({ ...base, fetchImpl: vi.fn(async () => { throw new Error(`fetch failed for ${TOKEN}`); }) as never });
    expect(JSON.stringify(net)).not.toContain(TOKEN);
  });
});
