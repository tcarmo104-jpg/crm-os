import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { BUCKET_LABEL, groupTasks, PRIORITY_LABEL, TASK_TYPE_LABEL } from '@/lib/tasks';
import { listTasks } from '@/repositories/tasks';
import { getCustomersByIds } from '@/repositories/customers';
import { listMembers } from '@/repositories/members';
import { ConfirmButton, Notice } from '@/components/ui';
import { NewTaskForm } from '@/components/sales-forms';
import { cancelTaskAction, completeTaskAction, reopenTaskAction } from './actions';

export const metadata: Metadata = { title: 'Tareas' };

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ view?: string; status?: string }> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();

  const seesOthers = session.permissions['tasks:read'] === 'org' || session.permissions['tasks:read'] === 'team';
  const view = sp.view === 'all' && seesOthers ? 'all' : 'mine';
  const status = sp.status === 'done' ? 'done' : 'open';

  const [tasks, members, flash] = await Promise.all([
    can(session, 'tasks:read')
      ? listTasks(db, { orgId: org.orgId, status, assigneeId: view === 'mine' ? session.user.id : undefined, limit: 300 })
      : Promise.resolve([]),
    listMembers(db, org.orgId),
    readFlash(),
  ]);
  const customers = await getCustomersByIds(db, [...new Set(tasks.flatMap((t) => (t.customerId ? [t.customerId] : [])))]);
  const cName = new Map(customers.map((c) => [c.id, c.fullName]));
  const nameOf = (uid: string | null) => {
    const m = members.find((x) => x.userId === uid);
    return uid ? (m?.fullName ?? m?.email ?? 'Alguien') : 'Sin asignar';
  };
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: org.orgTimezone });
  const groups = status === 'open' ? groupTasks(tasks, new Date(), org.orgTimezone) : [{ bucket: 'none' as const, tasks }];

  const taskScope = session.permissions['tasks:create'];
  const myTeam = members.find((m) => m.userId === session.user.id)?.teamId ?? null;
  const people = members.filter((m) => m.status === 'active' && m.userId !== session.user.id
    && (taskScope === 'org' || (taskScope === 'team' && myTeam !== null && m.teamId === myTeam)))
    .map((m) => ({ id: m.userId, name: m.fullName ?? m.email ?? 'Sin nombre' }));
  const q = (v: string, s: string) => `/tasks?${new URLSearchParams({ ...(v === 'all' ? { view: 'all' } : {}), ...(s === 'done' ? { status: 'done' } : {}) })}`;
  const back = q(view, status);

  return (
    <>
      <header className="page-head">
        <h1>Tareas</h1>
        <p className="muted">Lo que tienes que hacer, ordenado por urgencia. Las horas se muestran en la zona de tu organización ({org.orgTimezone}).</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      {can(session, 'tasks:create') ? (
        <section className="panel" aria-labelledby="new-task">
          <details>
            <summary><h2 id="new-task" style={{ display: 'inline', fontSize: '1rem' }}>Nueva tarea</h2></summary>
            <NewTaskForm returnTo={back} people={people} />
          </details>
        </section>
      ) : null}

      <section className="panel" aria-labelledby="list-title">
        <div className="panel-head" style={{ flexWrap: 'wrap', gap: 10 }}>
          <h2 id="list-title">{status === 'open' ? 'Pendientes' : 'Completadas'} ({tasks.length})</h2>
          <nav className="tabs" aria-label="Filtros">
            <Link href={q(view, 'open')} aria-current={status === 'open' ? 'page' : undefined}>Pendientes</Link>
            <Link href={q(view, 'done')} aria-current={status === 'done' ? 'page' : undefined}>Completadas</Link>
            {seesOthers ? (
              <>
                <Link href={q('mine', status)} aria-current={view === 'mine' ? 'page' : undefined}>Mías</Link>
                <Link href={q('all', status)} aria-current={view === 'all' ? 'page' : undefined}>{session.permissions['tasks:read'] === 'org' ? 'Todas' : 'De mi equipo'}</Link>
              </>
            ) : null}
          </nav>
        </div>

        {tasks.length === 0 ? (
          <div className="empty"><p><strong>{status === 'open' ? 'No tienes tareas pendientes.' : 'Aún no hay tareas completadas.'}</strong></p></div>
        ) : groups.map(({ bucket, tasks: list }) => (
          <div key={bucket}>
            {status === 'open' ? <h3 style={{ margin: '14px 0 4px', fontSize: '0.95rem', color: bucket === 'overdue' ? 'var(--danger)' : undefined }}>{BUCKET_LABEL[bucket]} ({list.length})</h3> : null}
            {list.map((t) => (
              <div className={`task-row ${t.status === 'done' ? 'done' : ''}`} key={t.id}>
                <div className="main">
                  <span className="t"><strong>{t.title}</strong>{' '}
                    {t.priority === 'high' ? <span className="badge badge-warn">{PRIORITY_LABEL.high}</span> : null}{' '}
                    <span className="badge">{TASK_TYPE_LABEL[t.type] ?? t.type}</span>
                  </span>
                  <span className="small muted">
                    {t.dueAt ? `Vence ${fmt.format(new Date(t.dueAt))}` : 'Sin fecha'}
                    {t.customerId ? <> · <Link href={`/customers/${t.customerId}`}>{cName.get(t.customerId) ?? 'Cliente'}</Link></> : null}
                    {t.opportunityId ? <> · <Link href={`/opportunities/${t.opportunityId}`}>Oportunidad</Link></> : null}
                    {view === 'all' ? ` · ${nameOf(t.assigneeId)}` : ''}
                  </span>
                  {t.outcome ? <span className="small">Resultado: {t.outcome}</span> : null}
                </div>
                <div className="acts">
                  {t.status === 'open' ? (
                    <>
                      <details>
                        <summary className="btn btn-secondary btn-sm">Completar</summary>
                        <form action={completeTaskAction} className="stack" style={{ marginTop: 6 }}>
                          <input type="hidden" name="taskId" value={t.id} />
                          <input type="hidden" name="returnTo" value={back} />
                          <label className="sr-only" htmlFor={`o-${t.id}`}>Resultado</label>
                          <input id={`o-${t.id}`} name="outcome" className="input" maxLength={500} placeholder="Resultado (opcional)" />
                          <button className="btn btn-primary btn-sm" type="submit">Guardar</button>
                        </form>
                      </details>
                      <form action={cancelTaskAction}>
                        <input type="hidden" name="taskId" value={t.id} /><input type="hidden" name="returnTo" value={back} />
                        <ConfirmButton message="¿Cancelar esta tarea?" className="btn btn-ghost btn-sm">Cancelar</ConfirmButton>
                      </form>
                    </>
                  ) : (
                    <form action={reopenTaskAction}>
                      <input type="hidden" name="taskId" value={t.id} /><input type="hidden" name="returnTo" value={back} />
                      <button className="btn btn-ghost btn-sm" type="submit">Reabrir</button>
                    </form>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </section>
    </>
  );
}
