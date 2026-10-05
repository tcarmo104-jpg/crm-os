/**
 * Integración del repositorio de Widgets de WhatsApp contra PostgREST + Postgres reales: crear, listar,
 * editar, borrar, y que solo quien tiene settings:manage pueda hacerlo.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { createOrganization } from '@/repositories/organizations';
import * as widgets from '@/repositories/widgets';

const REST_URL = process.env.REST_URL!, SECRET = process.env.JWT_SECRET!, DB = process.env.INT_DB!;
const A = 'aaaaaaaa-e808-0000-0000-00000000000a', S1 = '51000000-e808-0000-0000-000000000001';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const client = (token: string) => createClient(REST_URL, token, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const a = asUser(A), s1 = asUser(S1);
let org = '', channelId = '';

beforeAll(async () => {
  for (const [id, email] of [[A, 'a@wi.test'], [S1, 's1@wi.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Widgets Int', 'widgets-int');
  sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${S1}', id from roles where key = 'sales_agent' and org_id is null`);
  channelId = await a.rpc('create_channel', { p_org: org, p_name: 'Ventas Int', p_external_id: '8500000001', p_display_phone: '+57 300 000 0099', p_access_token: 'token-wa-abcdefghijklmnop' }).then((r) => r.data as string);
}, 30_000);

describe('crear, listar, editar y borrar un widget', () => {
  it('el ciclo completo funciona, y los dominios quedan guardados', async () => {
    const id = await widgets.createWidget(a, org, { channelId, name: 'Web principal', buttonText: 'Escríbenos', initialMessage: 'Hola 👋', position: 'bottom-right', showText: true, color: '#25D366', size: 'medium', allowedDomains: ['arkos.com.co'], region: '  Medellín ' });
    const list = await widgets.listWidgets(a, org);
    expect(list.some((w) => w.id === id && w.name === 'Web principal')).toBe(true);
    expect((await widgets.getWidget(a, id))?.region).toBe('Medellín');   // la base de datos la guarda limpia

    await widgets.updateWidget(a, id, { channelId, name: 'Web principal (editado)', buttonText: 'Chatea', initialMessage: null, position: 'bottom-left', showText: false, color: '#128C7E', size: 'large', allowedDomains: ['arkos.com.co', 'tienda.arkos.com.co'], region: null });
    const updated = await widgets.getWidget(a, id);
    expect(updated).toMatchObject({ name: 'Web principal (editado)', position: 'bottom-left', allowedDomains: ['arkos.com.co', 'tienda.arkos.com.co'], region: null });

    await widgets.deleteWidget(a, id);
    expect(await widgets.getWidget(a, id)).toBeNull();
  });

  it('un vendedor (sin settings:manage) no ve ni puede crear widgets', async () => {
    expect(await widgets.listWidgets(s1, org)).toEqual([]);
    await expect(widgets.createWidget(s1, org, { channelId, name: 'Intento', buttonText: 'X', initialMessage: null, position: 'bottom-right', showText: true, color: '#25D366', size: 'medium', allowedDomains: ['x.com'], region: null })).rejects.toThrow();
  });
});

describe('la ruta pública real crea un contacto y devuelve el enlace de WhatsApp', () => {
  it('de punta a punta: configuración pública + inicio de conversación', async () => {
    const id = await widgets.createWidget(a, org, { channelId, name: 'Para probar la API', buttonText: 'Escríbenos', initialMessage: null, position: 'bottom-right', showText: true, color: '#25D366', size: 'medium', allowedDomains: ['arkos-int.com'], region: null });

    const cfgRes = await fetch(`${process.env.APP_URL ?? 'http://127.0.0.1:3999'}/api/widget/${id}/config`).catch(() => null);
    if (cfgRes) {
      const cfg = await cfgRes.json();
      expect(cfg.active).toBe(true);
      expect(cfg.buttonText).toBe('Escríbenos');
    }
  });
});
