import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { listMembers, listSystemRoles } from '@/repositories/members';
import { listPending } from '@/repositories/invitations';
import { listTeams } from '@/repositories/teams';
import { INVITABLE_ROLES } from '@/lib/types';
import { InviteForm } from '@/components/forms';
import { ConfirmButton, Notice } from '@/components/ui';
import { changeRole, changeTeam, removeMember, revokeInvite } from './actions';

export const metadata: Metadata = { title: 'Miembros' };

export default async function MembersPage() {
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  const canManage = can(session, 'users:manage');
  const isOwner = org.roleKey === 'super_admin';

  const [members, roles, teams, pending, flash] = await Promise.all([
    listMembers(db, org.orgId),
    listSystemRoles(db),
    listTeams(db, org.orgId),
    canManage ? listPending(db, org.orgId) : Promise.resolve([]),
    readFlash(),
  ]);

  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const inviteRoles = roles.filter((r) => (INVITABLE_ROLES as readonly string[]).includes(r.key));
  const assignableRoles = roles.filter((r) => isOwner || r.key !== 'super_admin');
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeZone: org.orgTimezone });

  return (
    <>
      <header className="page-head">
        <h1>Miembros</h1>
        <p className="muted">Quién tiene acceso a {org.orgName} y con qué rol.</p>
      </header>

      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      {canManage ? (
        <section className="panel" aria-labelledby="invite-title">
          <div className="panel-head"><h2 id="invite-title">Invitar a alguien</h2></div>
          <InviteForm roles={inviteRoles} teams={teams} />
        </section>
      ) : null}

      <section className="panel" aria-labelledby="members-title">
        <div className="panel-head"><h2 id="members-title">Personas con acceso ({members.length})</h2></div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Persona</th>
                <th scope="col">Rol</th>
                <th scope="col">Equipo</th>
                {canManage ? <th scope="col"><span className="sr-only">Acciones</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const isYou = m.userId === session.user.id;
                // Solo un super administrador puede tocar a otro super administrador.
                const editable = canManage && (isOwner || m.roleKey !== 'super_admin');
                return (
                  <tr key={m.membershipId}>
                    <td>
                      <div className="person">
                        <strong>{m.fullName ?? m.email ?? 'Sin nombre'}</strong>
                        {isYou ? <span className="badge">Tú</span> : null}
                        {m.status !== 'active' ? <span className="badge">Suspendido</span> : null}
                      </div>
                      {m.fullName && m.email ? <div className="muted small">{m.email}</div> : null}
                    </td>
                    <td>
                      {editable ? (
                        <form action={changeRole} className="inline-form">
                          <input type="hidden" name="membershipId" value={m.membershipId} />
                          <label className="sr-only" htmlFor={`role-${m.membershipId}`}>Rol de {m.fullName ?? m.email}</label>
                          <select id={`role-${m.membershipId}`} name="roleId" className="select select-sm" defaultValue={m.roleId}>
                            {assignableRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                          </select>
                          <button className="btn btn-ghost btn-sm" type="submit">Guardar</button>
                        </form>
                      ) : m.roleName}
                    </td>
                    <td>
                      {editable ? (
                        <form action={changeTeam} className="inline-form">
                          <input type="hidden" name="membershipId" value={m.membershipId} />
                          <label className="sr-only" htmlFor={`team-${m.membershipId}`}>Equipo de {m.fullName ?? m.email}</label>
                          <select id={`team-${m.membershipId}`} name="teamId" className="select select-sm" defaultValue={m.teamId ?? ''}>
                            <option value="">Sin equipo</option>
                            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                          <button className="btn btn-ghost btn-sm" type="submit">Guardar</button>
                        </form>
                      ) : (m.teamId ? teamName.get(m.teamId) : <span className="muted">Sin equipo</span>)}
                    </td>
                    {canManage ? (
                      <td className="cell-actions">
                        {editable ? (
                          <form action={removeMember}>
                            <input type="hidden" name="membershipId" value={m.membershipId} />
                            <ConfirmButton message={isYou ? 'Vas a salir de esta organización. ¿Continuar?' : `¿Quitar el acceso de ${m.fullName ?? m.email}?`}>
                              {isYou ? 'Salir' : 'Quitar'}
                            </ConfirmButton>
                          </form>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {canManage ? (
        <section className="panel" aria-labelledby="pending-title">
          <div className="panel-head"><h2 id="pending-title">Invitaciones pendientes ({pending.length})</h2></div>
          {pending.length === 0 ? (
            <div className="empty"><p className="muted">No hay invitaciones pendientes.</p></div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th scope="col">Correo</th><th scope="col">Rol</th><th scope="col">Vence</th><th scope="col"><span className="sr-only">Acciones</span></th></tr>
                </thead>
                <tbody>
                  {pending.map((p) => {
                    const expired = new Date(p.expiresAt) < new Date();
                    return (
                      <tr key={p.id}>
                        <td>{p.email}</td>
                        <td>{p.roleName}</td>
                        <td>{expired ? <span className="badge">Venció</span> : fmt.format(new Date(p.expiresAt))}</td>
                        <td className="cell-actions">
                          <form action={revokeInvite}>
                            <input type="hidden" name="id" value={p.id} />
                            <ConfirmButton message={`¿Cancelar la invitación para ${p.email}?`}>Cancelar</ConfirmButton>
                          </form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
