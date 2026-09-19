import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listTeams } from '@/repositories/teams';
import { TeamForm } from '@/components/forms';

export const metadata: Metadata = { title: 'Equipos' };

export default async function TeamsPage() {
  const session = (await getSession())!;
  const teams = await listTeams(await createClient(), session.active!.orgId);
  const canManage = can(session, 'teams:manage');

  return (
    <>
      <header className="page-head">
        <h1>Equipos</h1>
        <p className="muted">
          Los equipos agrupan a las personas para que un Sales manager vea lo de su equipo, y para asignar clientes por región.
        </p>
      </header>

      {canManage ? (
        <section className="panel" aria-labelledby="new-team">
          <div className="panel-head"><h2 id="new-team">Nuevo equipo</h2></div>
          <TeamForm />
        </section>
      ) : null}

      <section className="panel" aria-labelledby="list-teams">
        <div className="panel-head"><h2 id="list-teams">Equipos de la organización</h2></div>
        {teams.length === 0 ? (
          <div className="empty">
            <p><strong>Aún no hay equipos.</strong></p>
            <p className="muted">
              {canManage ? 'Crea el primero con el formulario de arriba.' : 'Un administrador puede crearlos.'}
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Nombre</th><th scope="col">Región</th></tr></thead>
              <tbody>
                {teams.map((t) => (
                  <tr key={t.id}><td>{t.name}</td><td>{t.region ?? <span className="muted">Sin región</span>}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
