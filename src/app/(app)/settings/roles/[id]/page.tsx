import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { getCustomRole } from '@/repositories/roles';
import { ConfirmButton, Notice } from '@/components/ui';
import { RoleForm } from '@/components/role-form';
import { uuidSchema } from '@/services/schemas';
import { deleteRoleAction, updateRoleAction } from '../actions';

export const metadata: Metadata = { title: 'Editar rol' };

export default async function EditRolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const session = (await getSession())!;
  if (!can(session, 'roles:manage')) return <><header className="page-head"><h1>Rol</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;
  const db = await createClient();
  const [role, flash] = await Promise.all([getCustomRole(db, id), readFlash()]);
  if (!role) notFound();
  if (role.isSystem) return (
    <>
      <header className="page-head"><p className="small"><Link href="/settings/roles">← Roles y permisos</Link></p><h1>{role.name}</h1></header>
      <Notice kind="error">Este es un rol de sistema: no se puede editar ni eliminar. Crea un rol propio si necesitas otra combinación de permisos.</Notice>
    </>
  );

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href="/settings/roles">← Roles y permisos</Link></p>
        <h1>{role.name}</h1>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <form action={deleteRoleAction}>
        <input type="hidden" name="roleId" value={role.id} />
        <ConfirmButton message="¿Eliminar este rol? Solo se puede si nadie lo tiene asignado en este momento." className="btn btn-secondary btn-sm">Eliminar rol</ConfirmButton>
      </form>

      <section className="panel">
        <RoleForm mode="edit" roleId={role.id} initial={{ key: role.key, name: role.name, description: role.description, permissions: role.permissions }} action={updateRoleAction} />
      </section>
    </>
  );
}
