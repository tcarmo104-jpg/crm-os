import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listOpportunities } from '@/repositories/opportunities';
import { listTasks } from '@/repositories/tasks';
import { buildPerformance, groupByKey } from '@/lib/analytics';
import { loadAnalyticsScope } from '@/services/analytics-scope';
import { formatMoney } from '@/lib/money';
import { Kpi, Notice } from '@/components/ui';
import { ExportCsvLink } from '@/components/period-filter';
import { ColumnChart, Donut } from '@/components/charts';
import { PerformanceRank } from '@/components/analytics-parts';

export const metadata: Metadata = { title: 'Analítica — Desempeño' };
type SP = Record<string, string | string[] | undefined>;

/** Desempeño (lo que antes era /performance): ganadas, perdidas y tareas por persona en el período. Ahora también
 * respeta los filtros de asesor y equipo (como ya lo hacía la tabla del Dashboard). */
export default async function AnalyticsPerformancePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'reports:read')) return <Notice kind="error">No tienes acceso a este módulo.</Notice>;
  const db = await createClient();
  const scope = await loadAnalyticsScope(db, org, sp);
  const { range, filters } = scope;

  const [opps, tasks] = await Promise.all([
    listOpportunities(db, { orgId: org.orgId, closedFrom: range.from, closedTo: range.to, limit: 2000 }),
    listTasks(db, { orgId: org.orgId, status: 'done', completedFrom: range.from, completedTo: range.to, limit: 2000 }),
  ]);
  const closed = opps.filter((o) => o.status !== 'open' && scope.matches(o.ownerId));
  const done = tasks.filter((t) => scope.matches(t.assigneeId));
  const rows = buildPerformance(scope.people.map((m) => ({ id: m.userId })), closed.map((o) => ({ ownerId: o.ownerId, status: o.status as 'won' | 'lost', amount: o.amount })), done.map((t) => ({ assigneeId: t.assigneeId })));
  const money = (n: number) => formatMoney(n, null, org.orgLocale);

  const won = closed.filter((o) => o.status === 'won'), lost = closed.filter((o) => o.status === 'lost');
  const wonAmount = won.reduce((t, o) => t + o.amount, 0);
  const winRate = won.length + lost.length === 0 ? null : Math.round((won.length / (won.length + lost.length)) * 100);
  const byTeam = groupByKey(won, (o) => scope.teamOf.get(o.ownerId ?? '') ?? null, scope.teamName, (o) => o.amount);
  const top = [...rows].sort((a, b) => b.wonAmount - a.wonAmount).filter((r) => r.wonAmount > 0).slice(0, 8);
  const canExport = can(session, 'reports:export');

  return (
    <>
      <section className="kpi-grid" aria-label="Indicadores de desempeño">
        <Kpi href="/opportunities" icon="sparkle" label="Oportunidades ganadas" value={String(won.length)} sub={`${lost.length} perdidas`} tone="ok" />
        <Kpi href="/opportunities" icon="cash" label="Monto ganado" value={money(wonAmount)} sub={won.length ? `promedio ${money(wonAmount / won.length)}` : 'sin ganadas aún'} tone="primary" />
        <Kpi href="/opportunities" icon="target" label="Conversión" value={winRate === null ? '—' : `${winRate}%`} sub="ganadas sobre cerradas" tone={winRate !== null && winRate >= 50 ? 'ok' : 'neutral'} />
        <Kpi href="/tasks" icon="check" label="Tareas completadas" value={String(done.length)} sub={`${scope.people.length} ${scope.people.length === 1 ? 'persona' : 'personas'}`} tone="neutral" />
      </section>

      <div className="an-grid-wide">
        <section className="panel" aria-labelledby="perf-col-title">
          <div className="panel-head"><h2 id="perf-col-title">Monto ganado por persona</h2></div>
          <ColumnChart rows={top.map((r) => ({ label: scope.nameOf(r.personId).split(' ')[0]!, value: r.wonAmount, sub: `${r.won} ganadas` }))} format={money} />
        </section>
        <section className="panel" aria-labelledby="perf-team-title">
          <div className="panel-head"><h2 id="perf-team-title">Ganado por equipo</h2></div>
          <Donut rows={byTeam.map((t) => ({ label: t.label, value: t.amount }))} centerLabel="ganado" format={money} />
        </section>
      </div>

      <section className="panel" aria-labelledby="perf-title">
        <div className="panel-head">
          <h2 id="perf-title">Por persona</h2>
          {canExport ? <ExportCsvLink type="desempeno" preset={filters.periodo} desde={filters.desde} hasta={filters.hasta} extra={{ personas: filters.personas, equipos: filters.equipos }} /> : null}
        </div>
        <PerformanceRank rows={rows} nameOf={(id) => scope.nameOf(id)} teamOf={(id) => scope.teamName(scope.teamOf.get(id) ?? null)} money={money} />
      </section>
    </>
  );
}
