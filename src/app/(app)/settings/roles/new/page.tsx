import type { Metadata } from 'next';
import Link from 'next/link';
import { can, getSession } from '@/lib/session';
import { Notice } from '@/components/ui';
import { RoleForm } from '@/components/role-form';
import { createRoleAction } from '../actions';

export const metadata: Metadata = { title: 'Nuevo rol' };

export default async function NewRolePage() {
  const session = (await getSession())!;
  if (!can(session, 'roles:manage')) return <><header className="page-head"><h1>Nuevo rol</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href="/settings/roles">← Roles y permisos</Link></p>
        <h1>Nuevo rol</h1>
        <p className="muted">Elige exactamente qué puede ver y hacer cada permiso. «Sin acceso» es el valor por defecto: solo marca lo que de verdad necesita este rol.</p>
      </header>
      <section className="panel">
        <RoleForm mode="create" action={createRoleAction} />
      </section>
    </>
  );
}
