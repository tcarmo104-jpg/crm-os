import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { BUCKET_LABEL, buildTaskColumns, groupTasks, isOverdue, PRIORITY_LABEL, TASK_TYPE_LABEL, TASK_TYPES, type TaskStatus } from '@/lib/tasks';
import { listTasks } from '@/repositories/tasks';
import { getCustomersByIds, listCustomers } from '@/repositories/customers';
import { getOpportunitiesByIds, listOpportunities } from '@/repositories/opportunities';
import { listMembers } from '@/repositories/members';
import { Notice } from '@/components/ui';
import { FilterSelect, SearchInput } from '@/components/filters';
import { NewTaskModal, type Opt, type OppOpt } from '@/components/tasks/TaskModals';
import { TaskCard } from '@/components/tasks/TaskCard';

export const metadata: Metadata = { title: 'Tareas' };

type Params = { view?: string; estado?: string; vista?: string; tipo?: string; prioridad?: string; responsable?: string; q?: string };

export default async function TasksPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  if (!can(session, 'tasks:read')) return <><header className="page-head"><h1>Tareas</h1></header><Notice kind="error">No tienes acceso a este módulo.</Notice></>;

  const seesOthers = session.permissions['tasks:read'] === 'org' || session.permissions['tasks:read'] === 'team';
  const view = sp.view === 'all' && seesOthers ? 'all' : 'mine';
  const board = sp.vista === 'tablero';
  const estado = board ? '' : (['in_progress', 'done', 'cancelled', 'todas'].includes(sp.estado ?? '') ? sp.estado! : '');
  const type = TASK_TYPES.includes((sp.tipo ?? '') as (typeof TASK_TYPES)[number]) ? sp.tipo : undefined;
  const priority = ['low', 'normal', 'high'].includes(sp.prioridad ?? '') ? sp.prioridad : undefined;
  const q = (sp.q ?? '').trim() || undefined;

  const statuses: TaskStatus[] | undefined = board || estado === 'todas' ? ['open', 'in_progress', 'done', 'cancelled']
    : estado === '' ? ['open', 'in_progress'] : undefined;
  const status = statuses ? undefined : (estado as TaskStatus);

  const [tasksRaw, members, flash, custOptions, oppOptions] = await Promise.all([
    listTasks(db, {
      orgId: org.orgId, status, statuses, assigneeId: view === 'mine' ? session.user.id : (sp.responsable && sp.responsable !== 'sin_asignar' ? sp.responsable : undefined),
      unassigned: view === 'all' && sp.responsable === 'sin_asignar', type, priority, q, limit: 500,
    }),
    listMembers(db, org.orgId),
    readFlash(),
    can(session, 'customers:read') ? listCustomers(db, { orgId: org.orgId, userId: session.user.id, owner: 'all', limit: 400 }) : Promise.resolve({ items: [], nextCursor: null }),
    can(session, 'opportunities:read') ? listOpportunities(db, { orgId: org.orgId, status: 'open', limit: 400 }) : Promise.resolve([]),
  ]);
  const [customers, opportunityRows] = [custOptions.items, oppOptions];
  const [linkedCustomers, linkedOpps] = await Promise.all([
    getCustomersByIds(db, [...new Set(tasksRaw.flatMap((t) => (t.customerId ? [t.customerId] : [])))]),
    getOpportunitiesByIds(db, [...new Set(tasksRaw.flatMap((t) => (t.opportunityId ? [t.opportunityId] : [])))]),
  ]);
  const cName = new Map(linkedCustomers.map((c) => [c.id, c.fullName]));
  const oTitle = new Map(linkedOpps.map((o) => [o.id, o.title]));
  const nameOf = (uid: string | null) => {
    const m = members.find((x) => x.userId === uid);
    return uid ? (m?.fullName ?? m?.email ?? 'Alguien') : 'Sin asignar';
  };

  const taskScope = session.permissions['tasks:create'];
  const myTeam = members.find((m) => m.userId === session.user.id)?.teamId ?? null;
  const people: Opt[] = members.filter((m) => m.status === 'active' && m.userId !== session.user.id
    && (taskScope === 'org' || (taskScope === 'team' && myTeam !== null && m.teamId === myTeam)))
    .map((m) => ({ id: m.userId, name: m.fullName ?? m.email ?? 'Sin nombre' }));
  const custOpts: Opt[] = customers.map((c) => ({ id: c.id, name: c.fullName }));
  const oppOpts: OppOpt[] = opportunityRows.map((o) => ({ id: o.id, title: o.title, customerId: o.customerId }));

  const qs: Record<string, string> = {};
  if (view === 'all') qs.view = 'all';
  if (sp.estado) qs.estado = sp.estado;
  if (sp.vista) qs.vista = sp.vista;
  if (sp.tipo) qs.tipo = sp.tipo;
  if (sp.prioridad) qs.prioridad = sp.prioridad;
  if (sp.responsable) qs.responsable = sp.responsable;
  if (sp.q) qs.q = sp.q;
  const href = (patch: Record<string, string>) => { const p = new URLSearchParams({ ...qs, ...patch }); for (const k of Object.keys(patch)) if (!patch[k]) p.delete(k); const s = p.toString(); return s ? `/tasks?${s}` : '/tasks'; };
  const back = href({});

  const now = new Date();
  const groups = !board && estado === '' ? groupTasks(tasksRaw, now, org.orgTimezone) : null;
  const columns = board ? buildTaskColumns(tasksRaw) : null;
  const overdueCount = tasksRaw.filter((t) => isOverdue(t, now)).length;

  const card = (t: (typeof tasksRaw)[number], dense = false) => (
    <TaskCard key={t.id} task={t} customerName={t.customerId ? (cName.get(t.customerId) ?? null) : null} opportunityTitle={t.opportunityId ? (oTitle.get(t.opportunityId) ?? null) : null}
      assigneeName={nameOf(t.assigneeId)} showAssignee={view === 'all'} locale="es" timeZone={org.orgTimezone} people={people} returnTo={back} dense={dense} />
  );

  return (
    <>
      <header className="page-head">
        <h1>Tareas</h1>
        <p className="muted">Lo que tienes que hacer, ordenado por urgencia. Las horas se muestran en la zona de tu organización ({org.orgTimezone}).</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <div className="flt-bar">
        <SearchInput basePath="/tasks" initial={sp.q ?? ''} placeholder="Buscar por título o descripción" />
        <FilterSelect basePath="/tasks" param="estado" label="Estado" value={board ? '' : (sp.estado ?? '')} allLabel="Abiertas"
          options={[{ value: 'in_progress', label: 'En progreso' }, { value: 'done', label: 'Completadas' }, { value: 'cancelled', label: 'Canceladas' }, { value: 'todas', label: 'Todas' }]} />
        <FilterSelect basePath="/tasks" param="tipo" label="Tipo" value={sp.tipo ?? ''} options={TASK_TYPES.map((t) => ({ value: t, label: TASK_TYPE_LABEL[t] ?? t }))} />
        <FilterSelect basePath="/tasks" param="prioridad" label="Prioridad" value={sp.prioridad ?? ''} options={Object.entries(PRIORITY_LABEL).map(([v, l]) => ({ value: v, label: l }))} />
        {seesOthers ? (
          <FilterSelect basePath="/tasks" param="responsable" label="Responsable" value={view === 'all' ? (sp.responsable ?? '') : ''}
            options={[{ value: 'sin_asignar', label: 'Sin asignar' }, ...members.filter((m) => m.status === 'active').map((m) => ({ value: m.userId, label: m.fullName ?? m.email ?? 'Sin nombre' }))]} />
        ) : null}
        <div className="view-toggle" role="tablist" aria-label="Vista">
          <a href={href({ vista: '' })} aria-current={!board ? 'page' : undefined}>Lista</a>
          <a href={href({ vista: 'tablero' })} aria-current={board ? 'page' : undefined}>Tablero</a>
        </div>
      </div>

      <div className="flt-bar" style={{ marginTop: -4 }}>
        {seesOthers ? (
          <div className="view-toggle" role="tablist" aria-label="Alcance">
            <a href={href({ view: '' })} aria-current={view === 'mine' ? 'page' : undefined}>Mías</a>
            <a href={href({ view: 'all' })} aria-current={view === 'all' ? 'page' : undefined}>{session.permissions['tasks:read'] === 'org' ? 'Todas' : 'De mi equipo'}</a>
          </div>
        ) : null}
        {can(session, 'tasks:create') ? (
          <NewTaskModal trigger={<button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }}>+ Nueva tarea</button>} customers={custOpts} opportunities={oppOpts} people={people} returnTo={back} />
        ) : null}
      </div>

      {overdueCount > 0 && estado !== '' ? <Notice kind="error">Tienes {overdueCount} {overdueCount === 1 ? 'tarea vencida' : 'tareas vencidas'} fuera de este filtro.</Notice> : null}

      {tasksRaw.length === 0 ? (
        <div className="empty-state"><strong>{q || type || priority ? 'Nada coincide con estos filtros.' : 'No hay tareas aquí.'}</strong><p>Crea una nueva o ajusta los filtros de arriba.</p></div>
      ) : board ? (
        <div className="task-board">
          {columns!.map((col) => (
            <section key={col.status} className="task-col" aria-label={col.label}>
              <div className="task-col-head"><h3>{col.label}</h3><span className="badge badge-neutral">{col.tasks.length}</span></div>
              <div className="task-col-body">{col.tasks.length === 0 ? <p className="hint">Sin tareas</p> : col.tasks.map((t) => card(t, true))}</div>
            </section>
          ))}
        </div>
      ) : groups ? (
        <div className="stack">
          {groups.map(({ bucket, tasks }) => (
            <div key={bucket}>
              <h2 className={`task-bucket-head${bucket === 'overdue' ? ' is-overdue' : ''}`}>{BUCKET_LABEL[bucket]} ({tasks.length})</h2>
              <div className="task-list">{tasks.map((t) => card(t))}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="task-list">{tasksRaw.map((t) => card(t))}</div>
      )}
    </>
  );
}
