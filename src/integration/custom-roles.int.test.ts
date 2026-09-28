/**
 * Integración de Roles personalizados contra PostgREST + Postgres reales: crear un rol, asignarlo a una
 * persona, confirmar que esa persona SOLO puede hacer lo que el rol permite (nada más, nada menos), y las
 * guardas reales (no tocar un rol de sistema, no borrar uno en uso).
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import { createOrganization } from '@/repositories/organizations';
import * as customers from '@/repositories/customers';
import * as rolesService from '@/services/roles';
import * as roles from '@/repositories/roles';

const REST_URL = process.env.REST_URL!, SECRET = process.env.JWT_SECRET!, DB = process.env.INT_DB!;
const A = 'aaaaaaaa-b010-0000-0000-00000000000a', S1 = '51000000-b010-0000-0000-000000000001';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const client = (token: string) => createClient(REST_URL, token, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const a = asUser(A), s1 = asUser(S1);
let org = '';

beforeAll(async () => {
  for (const [id, email] of [[A, 'a@rl.test'], [S1, 's1@rl.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Roles Int', 'roles-int');
  sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${S1}', id from roles where key = 'viewer' and org_id is null`);
}, 30_000);

describe('crear un rol personalizado y validar antes de la base de datos', () => {
  it('rechaza sin permisos válidos, sin llamar al servidor', async () => {
    await expect(rolesService.createCustomRole(a, org, { key: 'x', name: 'X', permissions: [{ key: 'algo_falso', scope: 'org' }] })).rejects.toBeInstanceOf(UserFacingError);
  });
  it('un rol sin permiso roles:manage no puede crear roles', async () => {
    await expect(rolesService.createCustomRole(s1, org, { key: 'x2', name: 'X2', permissions: [] })).rejects.toThrow();
  });
});

describe('asignar un rol personalizado a una persona y verificar sus límites reales', () => {
  it('con el rol nuevo, la persona solo puede lo que el rol le da (ni más, ni menos)', async () => {
    const roleId = await rolesService.createCustomRole(a, org, {
      key: 'vendedor_junior_int', name: 'Vendedor junior Int',
      permissions: [{ key: 'leads:read', scope: 'own' }, { key: 'tasks:create', scope: 'own' }],
    });
    sql(`update memberships set role_id = '${roleId}' where org_id = '${org}' and user_id = '${S1}'`);

    // Puede lo que el rol le da: crear un cliente sigue bloqueado (nunca se le dio customers:create).
    await expect(customers.createCustomer(s1, org, 'person', 'Cliente Rol Int', [{ type: 'phone', value: '+573101110050' }], {})).rejects.toThrow();

    // Cambiar los permisos del rol amplía lo que esa MISMA persona puede hacer, sin tocar su membresía.
    await rolesService.setCustomRolePermissions(a, roleId, [{ key: 'leads:read', scope: 'own' }, { key: 'customers:create', scope: 'own' }]);
    const created = await customers.createCustomer(s1, org, 'person', 'Cliente Rol Int Dos', [{ type: 'phone', value: '+573101110051' }], {});
    expect(created.customerId).toBeTruthy();
  });
});

describe('las guardas reales: nunca tocar un rol de sistema, nunca borrar uno en uso', () => {
  it('no se puede renombrar ni borrar un rol de sistema', async () => {
    const sysRoleId = sql(`select id from roles where key = 'sales_agent' and org_id is null`);
    await expect(roles.renameCustomRole(a, sysRoleId, 'Hackeado', undefined)).rejects.toThrow();
    await expect(roles.deleteCustomRole(a, sysRoleId)).rejects.toThrow();
  });
  it('no se puede borrar un rol que alguien tiene asignado ahora mismo', async () => {
    const roleId = await rolesService.createCustomRole(a, org, { key: 'en_uso_int', name: 'En uso Int', permissions: [] });
    const c = await customers.createCustomer(a, org, 'person', 'Cliente En Uso Int', [{ type: 'phone', value: '+573101110052' }], {});
    void c;
    sql(`update memberships set role_id = '${roleId}' where org_id = '${org}' and user_id = '${S1}'`);
    await expect(roles.deleteCustomRole(a, roleId)).rejects.toThrow();
    sql(`update memberships set role_id = (select id from roles where key = 'viewer' and org_id is null) where org_id = '${org}' and user_id = '${S1}'`);
    await roles.deleteCustomRole(a, roleId);
    const gone = await roles.getCustomRole(a, roleId);
    expect(gone).toBeNull();
  });
});
