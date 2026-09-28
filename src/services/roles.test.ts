import { describe, expect, it, vi } from 'vitest';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import * as rolesService from './roles';

function fakeDb() {
  const calls: { fn: string; args: unknown }[] = [];
  const db = { rpc: vi.fn(async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: 'role-1', error: null }; }) } as unknown as ServerSupabase;
  return { db, calls };
}
const ORG = '22222222-2222-4222-8222-222222222222';
const rejects = async (p: Promise<unknown>, match?: RegExp) => { const e = await p.then(() => null, (e: unknown) => e); expect(e).toBeInstanceOf(UserFacingError); if (match) expect((e as Error).message).toMatch(match); };

describe('createCustomRole: valida antes de tocar la base de datos', () => {
  it('arma la llamada tal como la espera create_custom_role', async () => {
    const { db, calls } = fakeDb();
    await rolesService.createCustomRole(db, ORG, { key: 'vendedor_junior', name: '  Vendedor Junior  ', permissions: [{ key: 'leads:read', scope: 'own' }] });
    expect(calls[0]).toEqual({ fn: 'create_custom_role', args: { p_org: ORG, p_key: 'vendedor_junior', p_name: 'Vendedor Junior', p_description: null, p_permissions: [{ key: 'leads:read', scope: 'own' }] } });
  });
  it('rechaza una clave con mayúsculas, espacios o tildes, sin tocar la base de datos', async () => {
    const { db, calls } = fakeDb();
    await rejects(rolesService.createCustomRole(db, ORG, { key: 'Vendedor Junior', name: 'X', permissions: [] }));
    expect(calls).toHaveLength(0);
  });
  it('rechaza sin nombre', async () => {
    const { db } = fakeDb();
    await rejects(rolesService.createCustomRole(db, ORG, { key: 'x', name: '', permissions: [] }));
  });
  it('rechaza un permiso que no existe en el catálogo (evita inventar uno)', async () => {
    const { db } = fakeDb();
    await rejects(rolesService.createCustomRole(db, ORG, { key: 'x', name: 'X', permissions: [{ key: 'leads:volar', scope: 'own' }] }));
  });
  it('rechaza un alcance que no es own/team/org', async () => {
    const { db } = fakeDb();
    await rejects(rolesService.createCustomRole(db, ORG, { key: 'x', name: 'X', permissions: [{ key: 'leads:read', scope: 'universo' }] }));
  });
});

describe('renameCustomRole y setCustomRolePermissions: mismas validaciones básicas', () => {
  it('renombrar rechaza un nombre vacío', async () => {
    const { db } = fakeDb();
    await rejects(rolesService.renameCustomRole(db, 'role-1', { name: '' }));
  });
  it('cambiar permisos rechaza una clave de permiso inventada', async () => {
    const { db } = fakeDb();
    await rejects(rolesService.setCustomRolePermissions(db, 'role-1', [{ key: 'algo_falso', scope: 'org' }]));
  });
  it('una lista de permisos vacía es válida (un rol sin ningún permiso)', async () => {
    const { db, calls } = fakeDb();
    await rolesService.setCustomRolePermissions(db, 'role-1', []);
    expect(calls[0]).toMatchObject({ fn: 'set_custom_role_permissions', args: { p_role_id: 'role-1', p_permissions: [] } });
  });
});
