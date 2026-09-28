import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listOpportunities } from '@/repositories/opportunities';
import { listSales } from '@/repositories/sales';
import { listLeads } from '@/repositories/leads';
import { listTasks } from '@/repositories/tasks';
import { listPipelines } from '@/repositories/pipelines';
import { listMembers } from '@/repositories/members';
import { listTeams } from '@/repositories/teams';
import { listQuotes } from '@/repositories/quotes';
import {
  parseDashFilters, resolveDateRange, previousPeriod, pctChange, autoGranularity, buildTimeSeries,
  buildFunnelWithConversion, groupByKey, buildPerformance, buildAlerts,
} from '@/lib/analytics';
import { formatMoney } from '@/lib/money';
import { Kpi, Notice } from '@/components/ui';
import { DashboardFilters } from '@/components/dashboard-filters';
import { TrendLine, DistBar } from '@/components/charts';

export const metadata: Metadata = { title: 'Dashboard' };

type SP = { periodo?: string; desde?: string; hasta?: string; personas?: string | string[]; equipos?: string | string[]; canal?: string };

/** Las tareas vencidas son «ahora» (no dependen del rango elegido: una tarea vencida lo está hoy). */
function filterOverdueTasks(tasks: { assigneeId: string | null; dueAt: string | null }[], matches: (ownerId: string | null) => boolean) {
  const now = new Date().toISOString();
  return tasks.filter((t) => t.dueAt && t.dueAt < now && matches(t.assigneeId));
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'reports:read')) return <><header className="page-head"><h1>Dashboard</h1></header><Notice kind="error">No tienes acceso a este módulo.</Notice></>;
  const db = await createClient();

  const filters = parseDashFilters(sp);
  const range = resolveDateRange(filters.periodo, new Date(), org.orgTimezone, { from: filters.desde, to: filters.hasta });
  const prevRange = previousPeriod(range);
  const granularity = autoGranularity(range);

  const [pipelines, members, teams, openOppsAll, closedOppsAll, prevClosedOppsAll, salesAll, prevSalesAll, leadsAll, prevLeadsAll, doneTasksAll, pendingTasksAll, sentQuotesPage] = await Promise.all([
    listPipelines(db, org.orgId),
    listMembers(db, org.orgId),
    listTeams(db, org.orgId),
    listOpportunities(db, { orgId: org.orgId, status: 'open', limit: 2000 }),
    listOpportunities(db, { orgId: org.orgId, closedFrom: range.from, closedTo: range.to, limit: 2000 }),
    listOpportunities(db, { orgId: org.orgId, closedFrom: prevRange.from, closedTo: prevRange.to, limit: 2000 }),
    listSales(db, { orgId: org.orgId, soldFrom: range.from, soldTo: range.to, status: 'delivered', limit: 2000 }),
    listSales(db, { orgId: org.orgId, soldFrom: prevRange.from, soldTo: prevRange.to, status: 'delivered', limit: 2000 }),
    listLeads(db, { orgId: org.orgId, from: range.from, to: range.to, limit: 2000 }),
    listLeads(db, { orgId: org.orgId, from: prevRange.from, to: prevRange.to, limit: 2000 }),
    listTasks(db, { orgId: org.orgId, status: 'done', completedFrom: range.from, completedTo: range.to, limit: 2000 }),
    listTasks(db, { orgId: org.orgId, statuses: ['open', 'in_progress'], limit: 2000 }),
    can(session, 'quotes:read') ? listQuotes(db, { orgId: org.orgId, status: 'sent', limit: 500 }) : Promise.resolve({ items: [], nextCursor: null }),
  ]);

  // -------- Filtros globales (persona/equipo/canal), aplicados sobre lo ya traído --------
  const active = members.filter((m) => m.status === 'active');
  const teamOf = new Map(active.map((m) => [m.userId, m.teamId]));
  const nameOf = (id: string | null) => (id ? (active.find((m) => m.userId === id)?.fullName ?? active.find((m) => m.userId === id)?.email ?? 'Sin nombre') : 'Sin asignar');
  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? 'Sin equipo';
  const regionOf = (id: string | null) => teams.find((t) => t.id === id)?.region || 'Sin región';

  const matchesPersonTeam = (ownerId: string | null) => {
    if (filters.personas.length > 0 && !(ownerId && filters.personas.includes(ownerId))) return false;
    if (filters.equipos.length > 0 && !(ownerId && filters.equipos.includes(teamOf.get(ownerId) ?? ''))) return false;
    return true;
  };
  const openOpps = openOppsAll.filter((o) => matchesPersonTeam(o.ownerId));
  const closedOpps = closedOppsAll.filter((o) => matchesPersonTeam(o.ownerId));
  const prevClosedOpps = prevClosedOppsAll.filter((o) => matchesPersonTeam(o.ownerId));
  const sales = salesAll.items.filter((s) => matchesPersonTeam(s.ownerId));
  const prevSales = prevSalesAll.items.filter((s) => matchesPersonTeam(s.ownerId));
  const leads = leadsAll.items.filter((l) => matchesPersonTeam(l.ownerId) && (!filters.canal || l.channel === filters.canal));
  const prevLeads = prevLeadsAll.items.filter((l) => matchesPersonTeam(l.ownerId) && (!filters.canal || l.channel === filters.canal));
  const doneTasks = doneTasksAll.filter((t) => matchesPersonTeam(t.assigneeId));
  const overdueTasks = filterOverdueTasks(pendingTasksAll, matchesPersonTeam);

  // -------- KPIs con comparación contra el período anterior --------
  const won = closedOpps.filter((o) => o.status === 'won'), lost = closedOpps.filter((o) => o.status === 'lost');
  const prevWon = prevClosedOpps.filter((o) => o.status === 'won'), prevLost = prevClosedOpps.filter((o) => o.status === 'lost');
  const winRate = won.length + lost.length === 0 ? null : Math.round((won.length / (won.length + lost.length)) * 100);
  const prevWinRate = prevWon.length + prevLost.length === 0 ? null : Math.round((prevWon.length / (prevWon.length + prevLost.length)) * 100);
  const revenue = sales.reduce((t, s) => t + s.total, 0);
  const prevRevenue = prevSales.reduce((t, s) => t + s.total, 0);
  const avgTicket = sales.length === 0 ? 0 : revenue / sales.length;
  const money = (n: number) => formatMoney(n, null, org.orgLocale);
  const leadConversions = leads.filter((l) => l.resolution === 'matched' || l.resolution === 'created').length;
  const leadConvRate = leads.length === 0 ? null : Math.round((leadConversions / leads.length) * 100);

  const Compare = ({ curr, prev }: { curr: number; prev: number }) => {
    const p = pctChange(curr, prev);
    if (p === null) return null;
    return <span className={`kpi-compare ${p >= 0 ? 'kpi-compare--up' : 'kpi-compare--down'}`}>{p >= 0 ? '↑' : '↓'} {Math.abs(p)}% vs. período anterior</span>;
  };

  // -------- Gráfico de evolución --------
  const trend = buildTimeSeries(leads.map((l) => ({ at: l.receivedAt })), org.orgTimezone, granularity);
  const trendOpps = buildTimeSeries(closedOpps.filter((o) => o.status === 'won').map((o) => ({ at: o.closedAt! })), org.orgTimezone, granularity);
  const trendSales = buildTimeSeries(sales.map((s) => ({ at: s.soldAt, amount: s.total })), org.orgTimezone, granularity);
  const allKeys = [...new Set([...trend, ...trendOpps, ...trendSales].map((b) => b.key))].sort();
  const seriesFrom = (buckets: typeof trend, useAmount: boolean) => allKeys.map((k) => { const b = buckets.find((x) => x.key === k); return { label: b?.label ?? k, value: b ? (useAmount ? b.amount : b.count) : 0 }; });

  // -------- Embudo, distribuciones --------
  const defaultPipeline = pipelines[0];
  const funnel = defaultPipeline ? buildFunnelWithConversion(defaultPipeline.stages.filter((s) => s.kind === 'open'), openOpps.filter((o) => o.pipelineId === defaultPipeline.id)) : [];
  const byChannel = groupByKey(leads, (l) => l.channel, (k) => k);
  const byTeamSales = groupByKey(sales, (s) => teamOf.get(s.ownerId ?? '') ?? null, teamName, (s) => s.total);
  const byRegionSales = groupByKey(sales, (s) => regionOf(teamOf.get(s.ownerId ?? '') ?? null), (k) => k, (s) => s.total);
  const channels = [...new Set(leadsAll.items.map((l) => l.channel).filter((c): c is string => !!c))];

  // -------- Desempeño por persona --------
  const filteredPeople = active.filter((m) => (filters.personas.length === 0 || filters.personas.includes(m.userId)) && (filters.equipos.length === 0 || filters.equipos.includes(m.teamId ?? '')));
  const perf = buildPerformance(filteredPeople.map((m) => ({ id: m.userId })), closedOpps.filter((o) => o.status !== 'open').map((o) => ({ ownerId: o.ownerId, status: o.status as 'won' | 'lost', amount: o.amount })), doneTasks.map((t) => ({ assigneeId: t.assigneeId })));

  // -------- Alertas --------
  const leadsPendingContact = leadsAll.items.filter((l) => l.status === 'new' && matchesPersonTeam(l.ownerId)).length;
  const overdueOpenOpps = openOpps.filter((o) => o.expectedCloseDate && o.expectedCloseDate < new Date().toISOString().slice(0, 10)).length;
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const quotesPendingFollowUp = sentQuotesPage.items.filter((q) => matchesPersonTeam(q.ownerId) && q.sentAt && q.sentAt < fiveDaysAgo).length;
  const alerts = buildAlerts({ overdueTasks: overdueTasks.length, overdueOpportunities: overdueOpenOpps, leadsPendingContact, quotesPendingFollowUp });

  return (
    <>
      <header className="page-head">
        <h1>Dashboard</h1>
        <p className="muted">La foto de toda la organización (o de tu equipo, según tu rol) — a diferencia de «Hoy», que solo muestra lo tuyo.</p>
      </header>

      <DashboardFilters basePath="/dashboard" value={filters} people={active.map((m) => ({ id: m.userId, name: nameOf(m.userId) }))} teams={teams.map((t) => ({ id: t.id, name: t.name }))} channels={channels} />

      {alerts.length > 0 ? (
        <section className="panel" aria-labelledby="alerts-title">
          <div className="panel-head"><h2 id="alerts-title">Atención</h2></div>
          <ul className="alert-list">
            {alerts.map((a) => <li key={a.key}><Link href={a.href} className={`alert-row alert-row--${a.tone}`}><span>{a.label}</span><span aria-hidden="true">→</span></Link></li>)}
          </ul>
        </section>
      ) : null}

      <section className="kpi-grid" aria-label="Indicadores principales">
        <Kpi href="/opportunities" label="Pipeline abierto" value={money(openOpps.reduce((t, o) => t + o.amount, 0))} sub={`${openOpps.length} ${openOpps.length === 1 ? 'oportunidad' : 'oportunidades'}`} tone="primary" />
        <Kpi href="/sales" label="Ingresos del período" value={money(revenue)} sub={sales.length === 0 ? 'sin ventas aún' : `${sales.length} ${sales.length === 1 ? 'venta' : 'ventas'}`} tone="ok" />
        <Kpi href="/sales" label="Ticket promedio" value={money(avgTicket)} sub="por venta entregada" tone="neutral" />
        <Kpi href="/opportunities" label="Tasa de conversión (oport. → venta)" value={winRate === null ? '—' : `${winRate}%`} sub={`${won.length} ganadas · ${lost.length} perdidas`} tone={winRate !== null && winRate >= 50 ? 'ok' : 'neutral'} />
        <Kpi href="/leads" label="Leads del período" value={String(leads.length)} sub="ver detalle en Leads" tone="neutral" />
        <Kpi href="/leads" label="Conversión de leads" value={leadConvRate === null ? '—' : `${leadConvRate}%`} sub="ya son clientes" tone="neutral" />
        <Kpi href="/tasks" label="Tareas completadas" value={String(doneTasks.length)} sub="en el período" tone="ok" />
        <Kpi href="/tasks" label="Tareas vencidas ahora" value={String(overdueTasks.length)} sub="no depende del período: es hoy" tone={overdueTasks.length > 0 ? 'danger' : 'neutral'} />
      </section>
      <p className="hint" style={{ marginTop: -8 }}>
        Ingresos <Compare curr={revenue} prev={prevRevenue} /> · Ganadas <Compare curr={won.length} prev={prevWon.length} /> · Leads <Compare curr={leads.length} prev={prevLeads.length} />
        {prevWinRate !== null && winRate !== null ? <> · Conversión <Compare curr={winRate} prev={prevWinRate} /></> : null}
      </p>

      <section className="panel" aria-labelledby="trend-title">
        <div className="panel-head"><h2 id="trend-title">Evolución</h2></div>
        <div className="dash-grid-2">
          <div>
            <p className="small muted" style={{ marginBottom: 6 }}>Leads y oportunidades ganadas (cantidad)</p>
            <TrendLine series={[{ name: 'Leads', points: seriesFrom(trend, false) }, { name: 'Oportunidades ganadas', points: seriesFrom(trendOpps, false) }]} />
          </div>
          <div>
            <p className="small muted" style={{ marginBottom: 6 }}>Ventas (monto)</p>
            <TrendLine series={[{ name: 'Ventas', points: seriesFrom(trendSales, true) }]} />
          </div>
        </div>
      </section>

      {defaultPipeline ? (
        <section className="panel" aria-labelledby="funnel-title">
          <div className="panel-head"><h2 id="funnel-title">Embudo — {defaultPipeline.name}</h2><Link className="small" href="/funnel">Ver el embudo completo →</Link></div>
          <div className="funnel-big">
            {funnel.map((f) => (
              <div key={f.id} className="funnel-big-stage">
                <span className="funnel-big-name">{f.name}</span>
                <span className="funnel-big-count">{f.count}</span>
                <span className="funnel-big-amount">{money(f.amount)}</span>
                {f.conversion !== null ? <span className="funnel-big-conv">{f.conversion}% de la anterior</span> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="dash-grid-2">
        <section className="panel" aria-labelledby="channel-title">
          <div className="panel-head"><h2 id="channel-title">Leads por canal</h2></div>
          <DistBar rows={byChannel.map((c) => ({ label: c.label, count: c.count }))} />
        </section>
        <section className="panel" aria-labelledby="team-title">
          <div className="panel-head"><h2 id="team-title">Ventas por equipo</h2></div>
          <DistBar rows={byTeamSales.map((t) => ({ label: t.label, count: t.amount }))} valueLabel={money} />
        </section>
      </div>

      {byRegionSales.some((r) => r.label !== 'Sin región') ? (
        <section className="panel" aria-labelledby="region-title">
          <div className="panel-head"><h2 id="region-title">Ventas por región</h2></div>
          <DistBar rows={byRegionSales.map((r) => ({ label: r.label, count: r.amount }))} valueLabel={money} />
        </section>
      ) : null}

      <section className="panel" aria-labelledby="perf-title">
        <div className="panel-head"><h2 id="perf-title">Desempeño por persona</h2><Link className="small" href="/performance">Ver desempeño completo →</Link></div>
        {perf.every((r) => r.won === 0 && r.lost === 0 && r.tasksCompleted === 0) ? <p className="muted">Sin actividad en este período.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Persona</th><th scope="col">Equipo</th><th scope="col">Ganadas</th><th scope="col">Monto ganado</th><th scope="col">Conversión</th><th scope="col">Tareas</th></tr></thead>
              <tbody>{perf.map((r) => { const m = active.find((x) => x.userId === r.personId); return (
                <tr key={r.personId}><td>{nameOf(r.personId)}</td><td className="small">{teamName(m?.teamId ?? null)}</td><td className="small">{r.won}</td><td className="small">{money(r.wonAmount)}</td><td className="small">{r.winRate === null ? '—' : `${r.winRate}%`}</td><td className="small">{r.tasksCompleted}</td></tr>
              ); })}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
