import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listTeams } from '@/repositories/teams';
import { listMembers } from '@/repositories/members';
import { listPending } from '@/repositories/invitations';
import { countCustomers } from '@/repositories/customers';
import { listTasks } from '@/repositories/tasks';
import { groupTasks } from '@/lib/tasks';
import { Icon } from '@/components/Icon';

export const metadata: Metadata = { title: 'Hoy' };

function greeting(timeZone: string): string {
  let hour = new Date().getHours();
  try {
    hour = Number(new Intl.DateTimeFormat('es', { hour: 'numeric', hour12: false, timeZone }).format(new Date())) % 24;
  } catch { /* zona horaria inválida: usa la del servidor */ }
  if (hour < 12) return 'Buenos días';
  if (hour < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

export default async function TodayPage() {
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  const canManage = can(session, 'users:manage');

  const [teams, members, pending, customerCount, openTasks] = await Promise.all([
    listTeams(db, org.orgId),
    listMembers(db, org.orgId),
    canManage ? listPending(db, org.orgId) : Promise.resolve([]),
    can(session, 'customers:read') ? countCustomers(db, org.orgId) : Promise.resolve(0),
    can(session, 'tasks:read') ? listTasks(db, { orgId: org.orgId, status: 'open', assigneeId: session.user.id, limit: 200 }) : Promise.resolve([]),
  ]);
  const buckets = groupTasks(openTasks, new Date(), org.orgTimezone);
  const overdue = buckets.find((b) => b.bucket === 'overdue')?.tasks ?? [];
  const today = buckets.find((b) => b.bucket === 'today')?.tasks ?? [];
  const urgent = [...overdue, ...today];
  const fmtTime = new Intl.DateTimeFormat('es', { dateStyle: 'short', timeStyle: 'short', timeZone: org.orgTimezone });

  const firstName = (session.user.fullName ?? '').split(' ')[0];
  const steps = [
    { done: true, label: 'Crear la organización', href: null as string | null },
    { done: teams.length > 0, label: 'Crear un equipo', href: '/settings/teams' },
    { done: members.length > 1 || pending.length > 0, label: 'Invitar a alguien', href: '/settings/members' },
    { done: customerCount > 0, label: 'Importar o crear tus clientes', href: '/leads/import' },
  ];

  return (
    <>
      <header className="page-head">
        <h1>{greeting(org.orgTimezone)}{firstName ? `, ${firstName}` : ''}</h1>
        <p className="muted">{org.orgName}</p>
      </header>

      <section className="next-action" aria-labelledby="na-title">
        <h2 id="na-title">Tu próxima acción aparecerá aquí</h2>
        <p>
          Cuando tengas clientes y oportunidades, este espacio te dirá qué hacer ahora, por qué y cuándo, y después te
          mostrará la siguiente. Hoy no hay nada pendiente porque todavía no hay datos comerciales.
        </p>
      </section>

      {can(session, 'tasks:read') ? (
        <section className="panel" aria-labelledby="today-tasks">
          <div className="panel-head">
            <h2 id="today-tasks">Tus tareas de hoy</h2>
            <Link className="btn btn-secondary btn-sm" href="/tasks">Ver todas ({openTasks.length})</Link>
          </div>
          {urgent.length === 0 ? (
            <p className="muted">{openTasks.length === 0 ? 'No tienes tareas pendientes.' : 'Nada vence hoy ni está atrasado.'}</p>
          ) : (
            <ul className="id-list">
              {urgent.slice(0, 6).map((t) => (
                <li key={t.id}>
                  <span>
                    {t.customerId ? <Link href={`/customers/${t.customerId}`}>{t.title}</Link> : t.title}
                  </span>
                  <span className={overdue.includes(t) ? 'badge badge-danger' : 'badge'}>{overdue.includes(t) ? 'Vencida · ' : ''}{t.dueAt ? fmtTime.format(new Date(t.dueAt)) : ''}</span>
                </li>
              ))}
            </ul>
          )}
          {overdue.length > 0 ? <p className="hint">Tienes {overdue.length} {overdue.length === 1 ? 'tarea vencida' : 'tareas vencidas'}.</p> : null}
        </section>
      ) : null}

      <section className="panel" aria-labelledby="steps-title">
        <div className="panel-head">
          <h2 id="steps-title">Primeros pasos</h2>
        </div>
        <ul className="checklist">
          {steps.map((s) => (
            <li key={s.label} className={s.done ? 'is-done' : undefined}>
              <span className="check" aria-hidden="true">{s.done ? <Icon name="check" size={14} /> : null}</span>
              <span className="check-label">
                {s.href && !s.done ? <Link href={s.href}>{s.label}</Link> : s.label}
                <span className="sr-only">{s.done ? ' (completado)' : ' (pendiente)'}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
