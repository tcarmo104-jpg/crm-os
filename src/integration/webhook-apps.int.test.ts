/**
 * Cada organización guarda las credenciales de SU aplicación de Meta dentro del CRM. El webhook averigua de cuál viene cada aviso por su firma y
 * solo deja tocar los canales de esa organización. Ruta y base de datos reales.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import { GET, POST } from '@/app/api/webhooks/meta/route';
import type { ServerSupabase } from '@/lib/supabase/server';
import { toUserMessage } from '@/lib/errors';
import * as repo from '@/repositories/inbox';
import { createOrganization } from '@/repositories/organizations';
import { providerAppStatus, removeProviderApp, saveProviderApp } from '@/server/provider-apps';
import { createAdminClient } from '@/server/supabase-admin';

const REST_URL = process.env.REST_URL!, SECRET = process.env.JWT_SECRET!, DB = process.env.INT_DB!;
const X = 'aaaaaaaa-e111-0000-0000-00000000000a', Y = 'bbbbbbbb-e111-0000-0000-00000000000b', AG = '51000000-e111-0000-0000-000000000001';
const PX = '449876543210', PY = '459876543210', PAGE_Y = '100000000000913';
const APP_X = '111111111111111', APP_Y = '222222222222222';
const SX = 'clave-secreta-de-la-app-x-0000000001', SY = 'clave-secreta-de-la-app-y-0000000002', SP = 'clave-secreta-de-la-plataforma-3';
const TX = 'token-de-verificacion-de-x-largo-1', TY = 'token-de-verificacion-de-y-largo-2';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const client = (t: string) => createClient(REST_URL, t, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const x = asUser(X), y = asUser(Y), ag = asUser(AG);
let orgX = '', orgY = '';
const sign = (raw: string, s: string) => `sha256=${createHmac('sha256', s).update(raw).digest('hex')}`;
const post = (body: unknown, secret: string | null) => { const raw = JSON.stringify(body); return POST(new Request('https://crm.test/api/webhooks/meta', { method: 'POST', headers: secret ? { 'x-hub-signature-256': sign(raw, secret), 'content-type': 'application/json' } : { 'content-type': 'application/json' }, body: raw })); };
const get = (token: string) => GET(new Request(`https://crm.test/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=777`));
const wa = (pid: string, thread: string, id: string) => ({ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: pid }, contacts: [{ wa_id: thread, profile: { name: 'Cliente' } }],
  messages: [{ from: thread, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: `hola ${id}` } }] } }] });
const payload = (...entries: unknown[]) => ({ object: 'whatsapp_business_account', entry: entries });
const count = (ext: string) => Number(sql(`select count(*) from messages where external_id = '${ext}'`));

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = REST_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = jwt({ role: 'service_role' });
  delete process.env.META_APP_SECRET; delete process.env.META_VERIFY_TOKEN; delete process.env.META_APP_ID;
  for (const [id, email] of [[X, 'x@wa.test'], [Y, 'y@wa.test'], [AG, 'ag@wa.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  orgX = await createOrganization(x, 'Empresa X', 'empresa-x'); orgY = await createOrganization(y, 'Empresa Y', 'empresa-y');
  sql(`insert into memberships (org_id, user_id, role_id) select '${orgX}', '${AG}', id from roles where key = 'sales_agent' and org_id is null`);
  await repo.createChannel(x, orgX, { name: 'WA X', phoneNumberId: PX, token: 'EAAXtokenXtokenXtokenXtokenXtoken0001' });
  await repo.createChannel(y, orgY, { name: 'WA Y', phoneNumberId: PY, token: 'EAAYtokenYtokenYtokenYtokenYtoken0002' });
  await saveProviderApp(x, orgX, 'meta', { clientId: APP_X, secret: SX, verifyToken: TX });
  await saveProviderApp(y, orgY, 'meta', { clientId: APP_Y, secret: SY, verifyToken: TY });
}, 60_000);
afterAll(() => {
  delete process.env.META_APP_SECRET; delete process.env.META_VERIFY_TOKEN;
  sql('delete from provider_apps');            // la base de datos de pruebas es compartida: otras pruebas suponen «ninguna aplicación configurada»
});

describe('guardar y ver las credenciales de la aplicación', () => {
  it('el administrador ve su identificador y fecha, nunca la clave; el vendedor y otra empresa no pueden', async () => {
    expect(await providerAppStatus(x, orgX, 'meta')).toMatchObject({ clientId: APP_X });
    expect(JSON.stringify(await providerAppStatus(x, orgX, 'meta'))).not.toContain(SX);
    await expect(providerAppStatus(ag, orgX, 'meta')).rejects.toBeTruthy();
    await expect(providerAppStatus(y, orgX, 'meta')).rejects.toBeTruthy();
    await expect(saveProviderApp(ag, orgX, 'meta', { clientId: '333333333333333', secret: 'otra-clave-secreta-larga-1', verifyToken: 'otro-token-de-verificacion-1' })).rejects.toBeTruthy();
  });
  it('un identificador de app no se puede registrar en dos empresas (mensaje en español)', async () => {
    const e = await saveProviderApp(y, orgY, 'meta', { clientId: APP_X, secret: 'clave-secreta-larga-de-prueba', verifyToken: 'token-de-verificacion-prueba-1' }).then(() => null, (err: unknown) => err);
    expect(toUserMessage(e)).toMatch(/ya está conectada en otra organización|Ya existe un registro/);
    expect(await providerAppStatus(y, orgY, 'meta')).toMatchObject({ clientId: APP_Y });         // la suya sigue intacta
  });
  it('en la base de datos la clave queda guardada (y nunca en el flujo de eventos)', () => {
    expect(sql(`select count(*) from domain_events where payload::text like '%${SX}%' or payload::text like '%${TX}%'`)).toBe('0');
    expect(sql(`select count(*) from provider_apps where org_id = '${orgX}'`)).toBe('1');
  });
});

describe('verificación de Meta (GET): cada aplicación con SU token', () => {
  it('el token de X y el de Y verifican; uno inventado no', async () => {
    for (const t of [TX, TY]) { const r = await get(t); expect(r.status).toBe(200); expect(await r.text()).toBe('777'); }
    expect((await get('token-inventado-que-no-existe-1')).status).toBe(403);
  });
});

describe('avisos de Meta (POST): la firma dice de qué aplicación vienen', () => {
  it('firmado con la app de X y para un canal de X → se guarda en X', async () => {
    const r = await post(payload(wa(PX, '573001110001', 'wamid.x1')), SX);
    expect(r.status).toBe(200); expect(count('wamid.x1')).toBe(1);
    expect(sql(`select org_id from messages where external_id = 'wamid.x1'`)).toBe(orgX);
  });
  it('firmado con la app de Y para un canal de Y → se guarda en Y', async () => {
    expect((await post(payload(wa(PY, '573001110002', 'wamid.y1')), SY)).status).toBe(200);
    expect(sql(`select org_id from messages where external_id = 'wamid.y1'`)).toBe(orgY);
  });
  it('FALSIFICACIÓN: la app de X intenta escribir en el canal de Y → NO se guarda nada en Y', async () => {
    const r = await post(payload(wa(PY, '573001110003', 'wamid.ataque1')), SX);
    expect(r.status).toBe(200);
    expect(count('wamid.ataque1')).toBe(0);
    expect(sql(`select count(*) from conversations where org_id = '${orgY}' and thread_key = '573001110003'`)).toBe('0');
  });
  it('un aviso mezclado: solo entra lo de la propia empresa; y lo ajeno tampoco queda en el registro de reintentos', async () => {
    const r = await post(payload(wa(PX, '573001110004', 'wamid.mezcla.x'), wa(PY, '573001110005', 'wamid.mezcla.y')), SX);
    expect(r.status).toBe(200);
    expect(count('wamid.mezcla.x')).toBe(1); expect(count('wamid.mezcla.y')).toBe(0);
    expect(sql(`select count(*) from raw_events where payload::text like '%wamid.mezcla.y%' or payload::text like '%wamid.ataque1%'`)).toBe('0');
  });
  it('lo mismo para Messenger: la app de X no escribe en una página de Y', async () => {
    await repo.connectChannel(y, orgY, { kind: 'facebook', name: 'Página Y', externalId: PAGE_Y, token: 'EAAPAGEtokenPAGEtokenPAGEtoken0005' });
    const fb = { object: 'page', entry: [{ id: PAGE_Y, messaging: [{ sender: { id: '5500000000000913' }, recipient: { id: PAGE_Y }, timestamp: Date.now(), message: { mid: 'mid.ataque2', text: 'hola' } }] }] };
    expect((await post(fb, SX)).status).toBe(200); expect(count('mid.ataque2')).toBe(0);
    expect((await post(fb, SY)).status).toBe(200); expect(count('mid.ataque2')).toBe(1);                 // la dueña sí puede
  });
  it('una firma que no es de ninguna aplicación conocida se rechaza (401); sin firma también', async () => {
    expect((await post(payload(wa(PX, '573001110006', 'wamid.x9')), 'clave-de-otra-app-desconocida-999')).status).toBe(401);
    expect((await post(payload(wa(PX, '573001110006', 'wamid.x9')), null)).status).toBe(401);
    expect(count('wamid.x9')).toBe(0);
  });
  it('la aplicación de la PLATAFORMA (variables de Vercel) sigue funcionando y puede escribir en cualquier empresa', async () => {
    process.env.META_APP_SECRET = SP;
    try {
      expect((await post(payload(wa(PY, '573001110007', 'wamid.plat1')), SP)).status).toBe(200);
      expect(sql(`select org_id from messages where external_id = 'wamid.plat1'`)).toBe(orgY);
    } finally { delete process.env.META_APP_SECRET; }
    expect((await post(payload(wa(PY, '573001110008', 'wamid.plat2')), SP)).status).toBe(401);          // sin la variable, esa firma deja de valer
  });
  it('al quitar la aplicación de X, su firma deja de valer al instante', async () => {
    await removeProviderApp(x, orgX, 'meta');
    expect((await post(payload(wa(PX, '573001110009', 'wamid.x10')), SX)).status).toBe(401);
    expect((await get(TX)).status).toBe(403);
    expect((await get(TY)).status).toBe(200);                                                             // la de Y sigue
  });
});
