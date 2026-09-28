import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { listAllRoles } from '@/repositories/roles';
import { Notice } from '@/components/ui';

export const metadata: Metadata = { title: 'Roles y permisos' };

export default async function RolesPage() {
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'roles:manage')) return <><header className="page-head"><h1>Roles y permisos</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;
  const db = await createClient();
  const [roles, flash] = await Promise.all([listAllRoles(db, org.orgId), readFlash()]);
  const system = roles.filter((r) => r.isSystem);
  const custom = roles.filter((r) => !r.isSystem);

  return (
    <>
      <header className="page-head">
        <h1>Roles y permisos</h1>
        <p className="muted">Los roles de sistema no se pueden editar (así se mantiene la seguridad de base del CRM). Crea un rol propio cuando necesites una combinación de permisos distinta.</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <div className="flt-bar">
        <Link href="/settings/roles/new" className="btn btn-primary" style={{ marginLeft: 'auto' }}>+ Nuevo rol</Link>
      </div>

      <section className="panel" aria-labelledby="custom-title">
        <div className="panel-head"><h2 id="custom-title">Roles propios de tu organización ({custom.length})</h2></div>
        {custom.length === 0 ? <p className="muted">Aún no has creado ningún rol propio.</p> : (
          <ul className="id-list">
            {custom.map((r) => (
              <li key={r.id}>
                <span><Link href={`/settings/roles/${r.id}`}><strong>{r.name}</strong></Link>{r.description ? <span className="small muted"> — {r.description}</span> : null}</span>
                <span className="small muted">{r.permissions.length} {r.permissions.length === 1 ? 'permiso' : 'permisos'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="system-title">
        <div className="panel-head"><h2 id="system-title">Roles de sistema ({system.length})</h2></div>
        <ul className="id-list">
          {system.map((r) => <li key={r.id}><span><strong>{r.name}</strong></span><span className="small muted">{r.permissions.length} {r.permissions.length === 1 ? 'permiso' : 'permisos'}</span></li>)}
        </ul>
      </section>
    </>
  );
}
