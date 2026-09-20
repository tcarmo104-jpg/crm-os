/**
 * El webhook anota (solo un contador, sin contenido) cada llamada de Meta y el diagnóstico la lee: así el CRM puede decir si Meta
 * NO llega, si llega y se RECHAZA, o si llega y se acepta. Ruta y base de datos reales.
 */
import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { GET, POST } from '@/app/api/webhooks/meta/route';
import { diagnoseReception } from '@/lib/reception';
import { gatherReceptionFacts } from '@/server/meta-webhook';
import { createAdminClient } from '@/server/supabase-admin';

const SECRET = process.env.JWT_SECRET!;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const APP_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90', VERIFY = 'token-de-verificacion-prueba';
const admin = () => createAdminClient();
const sign = (raw: string, s = APP_SECRET) => `sha256=${createHmac('sha256', s).update(raw).digest('hex')}`;
type O = 'verify_ok' | 'verify_rejected' | 'accepted' | 'bad_signature' | 'no_secret' | 'bad_payload';
const hits = async (): Promise<Record<O, number>> => {
  const r = await admin().rpc('webhook_stats_summary', { p_days: 14 });
  const m: Record<string, number> = { verify_ok: 0, verify_rejected: 0, accepted: 0, bad_signature: 0, no_secret: 0, bad_payload: 0 };
  for (const x of (r.data ?? []) as { outcome: string; hits: number }[]) m[x.outcome] = Number(x.hits);
  return m as Record<O, number>;
};
const post = (raw: string, sig: string | null) => POST(new Request('https://crm.test/api/webhooks/meta', { method: 'POST', headers: sig ? { 'x-hub-signature-256': sig, 'content-type': 'application/json' } : { 'content-type': 'application/json' }, body: raw }));
const get = (qs: string) => GET(new Request(`https://crm.test/api/webhooks/meta${qs}`));
const EMPTY_WA = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.REST_URL!; process.env.SUPABASE_SERVICE_ROLE_KEY = jwt({ role: 'service_role' });
  process.env.META_APP_SECRET = APP_SECRET; process.env.META_VERIFY_TOKEN = VERIFY;
});

describe('cada llamada de Meta queda anotada', () => {
  it('abrir la dirección en el navegador NO cuenta como un intento de Meta (sigue dando «forbidden»)', async () => {
    const before = await hits();
    const r = await get('');
    expect(r.status).toBe(403); expect(await r.text()).toBe('forbidden');
    expect(await hits()).toEqual(before);
  });
  it('Meta intenta verificar con el token EQUIVOCADO → se rechaza y se anota', async () => {
    const before = await hits();
    expect((await get('?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=abc')).status).toBe(403);
    expect((await hits()).verify_rejected).toBe(before.verify_rejected + 1);
  });
  it('Meta verifica con el token correcto → responde el reto y se anota', async () => {
    const before = await hits();
    const r = await get(`?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`);
    expect(r.status).toBe(200); expect(await r.text()).toBe('12345');
    expect((await hits()).verify_ok).toBe(before.verify_ok + 1);
  });
  it('un aviso con la firma equivocada (clave secreta distinta) → 401 y se anota «bad_signature»', async () => {
    const before = await hits();
    expect((await post(EMPTY_WA, sign(EMPTY_WA, 'la-clave-de-otra-app-distinta-123456'))).status).toBe(401);
    expect((await post(EMPTY_WA, null)).status).toBe(401);
    expect((await hits()).bad_signature).toBe(before.bad_signature + 2);
  });
  it('un aviso bien firmado se acepta y se anota; uno con JSON roto se anota aparte', async () => {
    const before = await hits();
    expect((await post(EMPTY_WA, sign(EMPTY_WA))).status).toBe(200);
    expect((await post('{roto', sign('{roto'))).status).toBe(400);
    const after = await hits();
    expect(after.accepted).toBe(before.accepted + 1); expect(after.bad_payload).toBe(before.bad_payload + 1);
  });
  it('sin META_APP_SECRET en el servidor: 503 y se anota «no_secret»', async () => {
    const before = await hits(); delete process.env.META_APP_SECRET;
    try { expect((await post(EMPTY_WA, sign(EMPTY_WA))).status).toBe(503); } finally { process.env.META_APP_SECRET = APP_SECRET; }
    expect((await hits()).no_secret).toBe(before.no_secret + 1);
  });
  it('la tabla NO guarda contenido: solo resultado, cuántas veces y cuándo', async () => {
    const rows = await admin().rpc('webhook_stats_summary', { p_days: 14 });
    for (const r of (rows.data ?? []) as Record<string, unknown>[]) expect(Object.keys(r).sort()).toEqual(['hits', 'last_at', 'outcome']);
  });
});

describe('el diagnóstico lee esos contadores de la base real', () => {
  it('con rechazos por firma más recientes que los aceptados, dice «la clave secreta no coincide»', async () => {
    await post(EMPTY_WA, sign(EMPTY_WA, 'otra-clave-distinta-de-la-app-999'));
    const facts = await gatherReceptionFacts(admin(), { id: '00000000-0000-4000-8000-000000000000', orgId: '00000000-0000-4000-8000-000000000001', metadata: {}, lastWebhookAt: null }, { full: false, origin: 'https://crm.test' }, { env: { ...process.env } as NodeJS.ProcessEnv });
    expect(facts.secretSet && facts.verifyTokenSet && facts.siteUrlOk).toBe(true);
    expect(facts.stats.bad_signature.hits).toBeGreaterThan(0);
    const r = diagnoseReception(facts);
    expect(r.verdict.title).toMatch(/Meta SÍ está enviando mensajes, pero el CRM los rechaza/);
  });
});
