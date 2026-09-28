import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listOpportunities } from '@/repositories/opportunities';
import { listTasks } from '@/repositories/tasks';
import { listMembers } from '@/repositories/members';
import { parsePeriod, resolveDateRange, buildPerformance } from '@/lib/analytics';
import { formatMoney } from '@/lib/money';
import { Notice } from '@/components/ui';
import { PeriodFilter, ExportCsvLink } from '@/components/period-filter';

export const metadata: Metadata = { title: 'Desempeño' };

export default async function PerformancePage({ searchParams }: { searchParams: Promise<{ periodo?: string; desde?: string; hasta?: string }> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'reports:read')) return <><header className="page-head"><h1>Desempeño</h1></header><Notice kind="error">No tienes acceso a este módulo.</Notice></>;
  const db = await createClient();

  const { preset, desde, hasta } = parsePeriod(sp);
  const range = resolveDateRange(preset, new Date(), org.orgTimezone, { from: desde, to: hasta });

  const [members, opps, tasks] = await Promise.all([
    listMembers(db, org.orgId),
    listOpportunities(db, { orgId: org.orgId, closedFrom: range.from, closedTo: range.to, limit: 2000 }),
    listTasks(db, { orgId: org.orgId, status: 'done', completedFrom: range.from, completedTo: range.to, limit: 2000 }),
  ]);
  const active = members.filter((m) => m.status === 'active');
  const rows = buildPerformance(
    active.map((m) => ({ id: m.userId })),
    opps.filter((o) => o.status !== 'open').map((o) => ({ ownerId: o.ownerId, status: o.status as 'won' | 'lost', amount: o.amount })),
    tasks.map((t) => ({ assigneeId: t.assigneeId })),
  );
  const nameOf = (id: string) => active.find((m) => m.userId === id)?.fullName ?? active.find((m) => m.userId === id)?.email ?? 'Sin nombre';
  const money = (n: number) => formatMoney(n, null, org.orgLocale);

  return (
    <>
      <header className="page-head">
        <h1>Desempeño</h1>
        <p className="muted">Oportunidades ganadas y perdidas, y tareas completadas por cada persona en el período elegido.</p>
      </header>

      <div className="flt-bar">
        <PeriodFilter basePath="/performance" preset={preset} desde={desde} hasta={hasta} />
        {can(session, 'reports:export') ? <span style={{ marginLeft: 'auto' }}><ExportCsvLink type="desempeno" preset={preset} desde={desde} hasta={hasta} /></span> : null}
      </div>

      <section className="panel" aria-labelledby="perf-title">
        <div className="panel-head"><h2 id="perf-title">Por persona</h2></div>
        {rows.every((r) => r.won === 0 && r.lost === 0 && r.tasksCompleted === 0) ? (
          <p className="muted">Sin actividad en este período.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Persona</th><th scope="col">Ganadas</th><th scope="col">Monto ganado</th><th scope="col">Perdidas</th><th scope="col">Conversión</th><th scope="col">Tareas completadas</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.personId}>
                    <td>{nameOf(r.personId)}</td>
                    <td className="small">{r.won}</td>
                    <td className="small">{money(r.wonAmount)}</td>
                    <td className="small">{r.lost}</td>
                    <td className="small">{r.winRate === null ? '—' : `${r.winRate}%`}</td>
                    <td className="small">{r.tasksCompleted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
