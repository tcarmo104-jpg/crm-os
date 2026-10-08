import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listOpportunities } from '@/repositories/opportunities';
import { listSales } from '@/repositories/sales';
import { listLeads } from '@/repositories/leads';
import { listTasks } from '@/repositories/tasks';
import { listPipelines } from '@/repositories/pipelines';
import { listQuotes } from '@/repositories/quotes';
import { autoGranularity, buildAlerts, buildFunnelWithConversion, buildPerformance, buildTimeSeries, groupByKey, pctChange, tabHref, tabOf } from '@/lib/analytics';
import { loadAnalyticsScope } from '@/services/analytics-scope';
import { formatMoney } from '@/lib/money';
import { Kpi, Notice } from '@/components/ui';
import { Donut, DistBar, TrendLine } from '@/components/charts';
import { FunnelVisual, PerformanceRank } from '@/components/analytics-parts';

export const metadata: Metadata = { title: 'Analítica — Resumen' };
type SP = Record<string, string | string[] | undefined>;

/** Resumen (lo que antes era /dashboard): los mismos datos, consultas y cálculos, en tarjetas y gráficos. */
export default async function AnalyticsSummaryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'reports:read')) return <Notice kind="error">No tienes acceso a este módulo.</Notice>;
  const db = await createClient();
  const scope = await loadAnalyticsScope(db, org, sp);
  const { filters, range, prevRange, matches } = scope;
  const granularity = autoGranularity(range);

  const [pipelines, openOppsAll, closedOppsAll, prevClosedOppsAll, salesAll, prevSalesAll, leadsAll, prevLeadsAll, doneTasksAll, pendingTasksAll, sentQuotesPage] = await Promise.all([
    listPipelines(db, org.orgId),
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

  // -------- Filtros globales (persona/equipo/canal), aplicados sobre lo ya traído — igual que el Dashboard --------
  const byChannelFilter = (c: string | null) => !filters.canal || c === filters.canal;
  const openOpps = openOppsAll.filter((o) => matches(o.ownerId));
  const closedOpps = closedOppsAll.filter((o) => matches(o.ownerId));
  const prevClosedOpps = prevClosedOppsAll.filter((o) => matches(o.ownerId));
  const sales = salesAll.items.filter((s) => matches(s.ownerId));
  const prevSales = prevSalesAll.items.filter((s) => matches(s.ownerId));
  const leads = leadsAll.items.filter((l) => matches(l.ownerId) && byChannelFilter(l.channel));
  const prevLeads = prevLeadsAll.items.filter((l) => matches(l.ownerId) && byChannelFilter(l.channel));
  const doneTasks = doneTasksAll.filter((t) => matches(t.assigneeId));
  const nowIso = new Date().toISOString();
  const overdueTasks = pendingTasksAll.filter((t) => t.dueAt && t.dueAt < nowIso && matches(t.assigneeId));

  // -------- KPIs con comparación contra el período anterior --------
  const won = closedOpps.filter((o) => o.status === 'won'), lost = closedOpps.filter((o) => o.status === 'lost');
  const prevWon = prevClosedOpps.filter((o) => o.status === 'won'), prevLost = prevClosedOpps.filter((o) => o.status === 'lost');
  const winRate = won.length + lost.length === 0 ? null : Math.round((won.length / (won.length + lost.length)) * 100);
  const prevWinRate = prevWon.length + prevLost.length === 0 ? null : Math.round((prevWon.length / (prevWon.length + prevLost.length)) * 100);
  const revenue = sales.reduce((t, s) => t + s.total, 0);
  const prevRevenue = prevSales.reduce((t, s) => t + s.total, 0);
  const avgTicket = sales.length === 0 ? 0 : revenue / sales.length;
  const prevAvgTicket = prevSales.length === 0 ? 0 : prevRevenue / prevSales.length;
  const money = (n: number) => formatMoney(n, null, org.orgLocale);
  const leadConversions = leads.filter((l) => l.resolution === 'matched' || l.resolution === 'created').length;
  const leadConvRate = leads.length === 0 ? null : Math.round((leadConversions / leads.length) * 100);
  const pipelineTotal = openOpps.reduce((t, o) => t + o.amount, 0);

  // -------- Evolución --------
  const trendLeads = buildTimeSeries(leads.map((l) => ({ at: l.receivedAt })), org.orgTimezone, granularity);
  const trendWon = buildTimeSeries(won.map((o) => ({ at: o.closedAt! })), org.orgTimezone, granularity);
  const trendSales = buildTimeSeries(sales.map((s) => ({ at: s.soldAt, amount: s.total })), org.orgTimezone, granularity);
  const keys = [...new Set([...trendLeads, ...trendWon, ...trendSales].map((b) => b.key))].sort();
  const labelOf = new Map([...trendLeads, ...trendWon, ...trendSales].map((b) => [b.key, b.label]));
  const seriesFrom = (buckets: typeof trendLeads, useAmount: boolean) => keys.map((k) => { const b = buckets.find((x) => x.key === k); return { label: labelOf.get(k) ?? k, value: b ? (useAmount ? b.amount : b.count) : 0 }; });

  // -------- Embudo, distribuciones, desempeño, alertas --------
  const pipeline = pipelines[0];
  const funnel = pipeline ? buildFunnelWithConversion(pipeline.stages.filter((s) => s.kind === 'open'), openOpps.filter((o) => o.pipelineId === pipeline.id)) : [];
  const byChannel = groupByKey(leads, (l) => l.channel, (k) => k);
  const byTeamSales = groupByKey(sales, (s) => scope.teamOf.get(s.ownerId ?? '') ?? null, scope.teamName, (s) => s.total);
  const byRegionSales = groupByKey(sales, (s) => scope.regionOf(scope.teamOf.get(s.ownerId ?? '') ?? null), (k) => k, (s) => s.total);
  const perf = buildPerformance(scope.people.map((m) => ({ id: m.userId })), closedOpps.filter((o) => o.status !== 'open').map((o) => ({ ownerId: o.ownerId, status: o.status as 'won' | 'lost', amount: o.amount })), doneTasks.map((t) => ({ assigneeId: t.assigneeId })));

  const leadsPendingContact = leadsAll.items.filter((l) => l.status === 'new' && matches(l.ownerId)).length;
  const overdueOpenOpps = openOpps.filter((o) => o.expectedCloseDate && o.expectedCloseDate < nowIso.slice(0, 10)).length;
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const quotesPendingFollowUp = sentQuotesPage.items.filter((q) => matches(q.ownerId) && q.sentAt && q.sentAt < fiveDaysAgo).length;
  const alerts = buildAlerts({ overdueTasks: overdueTasks.length, overdueOpportunities: overdueOpenOpps, leadsPendingContact, quotesPendingFollowUp });
  const link = (path: string) => tabHref(tabOf(path), sp);

  return (
    <>
      {alerts.length > 0 ? (
        <section className="panel" aria-labelledby="alerts-title">
          <div className="panel-head"><h2 id="alerts-title">Atención</h2></div>
          <ul className="alert-list">
            {alerts.map((a) => <li key={a.key}><Link href={a.href} className={`alert-row alert-row--${a.tone}`}><span>{a.label}</span><span aria-hidden="true">→</span></Link></li>)}
          </ul>
        </section>
      ) : null}

      <section className="kpi-grid" aria-label="Indicadores principales">
        <Kpi href="/opportunities" icon="target" label="Pipeline abierto" value={money(pipelineTotal)} sub={`${openOpps.length} ${openOpps.length === 1 ? 'oportunidad' : 'oportunidades'}`} tone="primary" />
        <Kpi href="/sales" icon="cash" label="Ingresos del período" value={money(revenue)} sub={sales.length === 0 ? 'sin ventas aún' : `${sales.length} ${sales.length === 1 ? 'venta' : 'ventas'}`} tone="ok" delta={pctChange(revenue, prevRevenue)} />
        <Kpi href="/sales" icon="chart" label="Ticket promedio" value={money(avgTicket)} sub="por venta entregada" tone="neutral" delta={sales.length && prevSales.length ? pctChange(avgTicket, prevAvgTicket) : null} />
        <Kpi href="/opportunities" icon="sparkle" label="Conversión (oport. → venta)" value={winRate === null ? '—' : `${winRate}%`} sub={`${won.length} ganadas · ${lost.length} perdidas`} tone={winRate !== null && winRate >= 50 ? 'ok' : 'neutral'} delta={winRate !== null && prevWinRate !== null ? pctChange(winRate, prevWinRate) : null} />
        <Kpi href="/leads" icon="funnel" label="Leads del período" value={String(leads.length)} sub="ver detalle en Leads" tone="primary" delta={pctChange(leads.length, prevLeads.length)} />
        <Kpi href="/leads" icon="users" label="Conversión de leads" value={leadConvRate === null ? '—' : `${leadConvRate}%`} sub="ya son clientes" tone="neutral" />
        <Kpi href="/tasks" icon="check" label="Tareas completadas" value={String(doneTasks.length)} sub="en el período" tone="ok" />
        <Kpi href="/tasks" icon="bolt" label="Tareas vencidas ahora" value={String(overdueTasks.length)} sub="no depende del período: es hoy" tone={overdueTasks.length > 0 ? 'danger' : 'neutral'} />
      </section>

      <div className="an-grid-wide">
        <section className="panel" aria-labelledby="trend-title">
          <div className="panel-head"><h2 id="trend-title">Leads y oportunidades ganadas</h2></div>
          <TrendLine area series={[{ name: 'Leads', points: seriesFrom(trendLeads, false) }, { name: 'Oportunidades ganadas', points: seriesFrom(trendWon, false) }]} />
        </section>
        <section className="panel" aria-labelledby="channel-title">
          <div className="panel-head"><h2 id="channel-title">Leads por canal</h2></div>
          <Donut rows={byChannel.map((c) => ({ label: c.label, value: c.count }))} centerLabel="leads" />
        </section>
      </div>

      <div className="an-grid-wide">
        <section className="panel" aria-labelledby="sales-title">
          <div className="panel-head"><h2 id="sales-title">Ventas (monto)</h2></div>
          <TrendLine area colorOffset={1} format={money} series={[{ name: 'Ventas entregadas', points: seriesFrom(trendSales, true) }]} />
        </section>
        <section className="panel" aria-labelledby="team-title">
          <div className="panel-head"><h2 id="team-title">Ventas por equipo</h2></div>
          <Donut rows={byTeamSales.map((t) => ({ label: t.label, value: t.amount }))} centerLabel="vendido" format={money} />
        </section>
      </div>

      <div className="an-grid-2">
        {pipeline ? (
          <section className="panel" aria-labelledby="funnel-title">
            <div className="panel-head"><h2 id="funnel-title">Embudo — {pipeline.name}</h2><Link className="small" href={link('/analytics/embudo')}>Ver el embudo →</Link></div>
            <FunnelVisual stages={funnel} money={money} compact />
          </section>
        ) : null}
        {byRegionSales.some((r) => r.label !== 'Sin región') ? (
          <section className="panel" aria-labelledby="region-title">
            <div className="panel-head"><h2 id="region-title">Ventas por región</h2></div>
            <DistBar rows={byRegionSales.map((r) => ({ label: r.label, count: r.amount }))} valueLabel={money} />
          </section>
        ) : null}
      </div>

      <section className="panel" aria-labelledby="perf-title">
        <div className="panel-head"><h2 id="perf-title">Mejores del período</h2><Link className="small" href={link('/analytics/desempeno')}>Ver el desempeño de todos →</Link></div>
        <PerformanceRank rows={perf} limit={5} nameOf={(id) => scope.nameOf(id)} teamOf={(id) => scope.teamName(scope.teamOf.get(id) ?? null)} money={money} />
      </section>
    </>
  );
}
