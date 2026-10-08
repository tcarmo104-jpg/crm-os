import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listOpportunities } from '@/repositories/opportunities';
import { listLeads } from '@/repositories/leads';
import { listSales } from '@/repositories/sales';
import { listTasks } from '@/repositories/tasks';
import { loadAnalyticsScope } from '@/services/analytics-scope';
import { groupSalesByPeriod, groupLeadsBySource, buildPerformance, parseWidgetFilters, breakdownWidgetFacts, formatDuration, WIDGET_DIMENSION_LABEL } from '@/lib/analytics';
import { loadWidgetMetrics } from '@/services/widget-metrics';
import { toCsv } from '@/lib/csv';
import { formatMoney } from '@/lib/money';

export const dynamic = 'force-dynamic';

/** Descarga un reporte como CSV. Un enlace normal (`<a href>`) basta: no hace falta JavaScript. */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.active) return new Response('No autorizado', { status: 401 });
  if (!can(session, 'reports:export')) return new Response('No tienes permiso para exportar reportes.', { status: 403 });

  const org = session.active;
  const db = await createClient();
  const sp = request.nextUrl.searchParams;
  const type = sp.get('type');
  // Los mismos filtros globales que la pantalla de Analítica (período, asesor, equipo, canal): lo que se
  // descarga es exactamente lo que se ve en la pestaña.
  const scope = await loadAnalyticsScope(db, org, sp);
  const { range, matches, filters } = scope;

  let csv: string; let filename: string;
  if (type === 'ventas') {
    const sales = await listSales(db, { orgId: org.orgId, soldFrom: range.from, soldTo: range.to, status: 'delivered', limit: 2000 });
    const buckets = groupSalesByPeriod(sales.items.filter((x) => matches(x.ownerId)), org.orgTimezone, 'month');
    csv = toCsv(['Período', 'Ventas', 'Monto'], buckets.map((b) => [b.label, b.count, formatMoney(b.amount, null, org.orgLocale)]));
    filename = 'ventas-por-periodo.csv';
  } else if (type === 'leads') {
    const leads = await listLeads(db, { orgId: org.orgId, from: range.from, to: range.to, limit: 2000 });
    const buckets = groupLeadsBySource(leads.items.filter((l) => matches(l.ownerId) && (!filters.canal || l.channel === filters.canal)).map((l) => ({ source: l.source, resolution: l.resolution })));
    csv = toCsv(['Fuente', 'Leads', 'Ya eran clientes'], buckets.map((b) => [b.source, b.count, b.matched]));
    filename = 'leads-por-fuente.csv';
  } else if (type === 'desempeno') {
    const [opps, tasks] = await Promise.all([
      listOpportunities(db, { orgId: org.orgId, closedFrom: range.from, closedTo: range.to, limit: 2000 }),
      listTasks(db, { orgId: org.orgId, status: 'done', completedFrom: range.from, completedTo: range.to, limit: 2000 }),
    ]);
    const rows = buildPerformance(scope.people.map((m) => ({ id: m.userId })),
      opps.filter((o) => o.status !== 'open' && matches(o.ownerId)).map((o) => ({ ownerId: o.ownerId, status: o.status as 'won' | 'lost', amount: o.amount })),
      tasks.filter((t) => matches(t.assigneeId)).map((t) => ({ assigneeId: t.assigneeId })));
    csv = toCsv(['Persona', 'Equipo', 'Ganadas', 'Monto ganado', 'Perdidas', 'Tasa de conversión', 'Tareas completadas'],
      rows.map((r) => [scope.nameOf(r.personId), scope.teamName(scope.teamOf.get(r.personId) ?? null), r.won, formatMoney(r.wonAmount, null, org.orgLocale), r.lost, r.winRate === null ? '—' : `${r.winRate}%`, r.tasksCompleted]));
    filename = 'desempeno.csv';
  } else if (type === 'widget') {
    // Los mismos filtros que la pestaña Widget de WhatsApp: lo que se descarga es lo que se ve.
    const raw: Record<string, string | string[]> = {};
    for (const k of new Set(sp.keys())) { const all = sp.getAll(k); raw[k] = all.length > 1 ? all : all[0]!; }
    const filters = parseWidgetFilters(raw);
    const data = await loadWidgetMetrics(db, org, filters);
    const rows = breakdownWidgetFacts(data.facts, filters.por, data.labelOf(filters.por));
    const pct = (n: number | null) => (n === null ? '—' : `${n}%`);
    csv = toCsv([WIDGET_DIMENSION_LABEL[filters.por], 'Iniciadas', 'Nuevos', 'Recurrentes', 'Escribieron por WhatsApp', 'Oportunidades', 'Conversión a oportunidad', 'Ventas', 'Conversión a venta', 'Monto', 'Primera respuesta (promedio)', 'Resolución (promedio)'],
      rows.map((r) => [r.label, r.summary.started, r.summary.newContacts, r.summary.returning, r.summary.reachedWhatsapp, r.summary.opportunities, pct(r.summary.oppRate),
        r.summary.sales, pct(r.summary.saleRate), formatMoney(r.summary.salesAmount, null, org.orgLocale), formatDuration(r.summary.avgFirstResponseMs), formatDuration(r.summary.avgResolutionMs)]));
    filename = `widget-whatsapp-por-${filters.por}.csv`;
  } else {
    return new Response('Reporte desconocido.', { status: 400 });
  }

  return new Response(`\uFEFF${csv}`, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` } });
}
