import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listSales } from '@/repositories/sales';
import { listLeads } from '@/repositories/leads';
import { groupLeadsBySource, groupSalesByPeriod } from '@/lib/analytics';
import { loadAnalyticsScope } from '@/services/analytics-scope';
import { formatMoney } from '@/lib/money';
import { Kpi, Notice } from '@/components/ui';
import { ExportCsvLink } from '@/components/period-filter';
import { ColumnChart, Donut } from '@/components/charts';

export const metadata: Metadata = { title: 'Analítica — Reportes' };
type SP = Record<string, string | string[] | undefined>;

/** Reportes (lo que antes era /reports): ventas por período y leads por fuente, con gráfico y con la tabla
 * exacta que se descarga en CSV. Ahora respeta también asesor, equipo y canal (el canal, solo en leads). */
export default async function AnalyticsReportsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'reports:read')) return <Notice kind="error">No tienes acceso a este módulo.</Notice>;
  const db = await createClient();
  const scope = await loadAnalyticsScope(db, org, sp);
  const { range, filters } = scope;
  const canExport = can(session, 'reports:export');

  const [salesPage, leadsPage] = await Promise.all([
    listSales(db, { orgId: org.orgId, soldFrom: range.from, soldTo: range.to, status: 'delivered', limit: 2000 }),
    listLeads(db, { orgId: org.orgId, from: range.from, to: range.to, limit: 2000 }),
  ]);
  const sales = salesPage.items.filter((s) => scope.matches(s.ownerId));
  const leads = leadsPage.items.filter((l) => scope.matches(l.ownerId) && (!filters.canal || l.channel === filters.canal));
  const salesByPeriod = groupSalesByPeriod(sales, org.orgTimezone, 'month');
  const leadsBySource = groupLeadsBySource(leads.map((l) => ({ source: l.source, resolution: l.resolution })));
  const money = (n: number) => formatMoney(n, null, org.orgLocale);
  const revenue = sales.reduce((t, s) => t + s.total, 0);
  const matched = leadsBySource.reduce((t, b) => t + b.matched, 0);
  const exportExtra = { personas: filters.personas, equipos: filters.equipos, canal: filters.canal };

  return (
    <>
      <section className="kpi-grid" aria-label="Indicadores de los reportes">
        <Kpi href="/sales" icon="cash" label="Ventas entregadas" value={money(revenue)} sub={`${sales.length} ${sales.length === 1 ? 'venta' : 'ventas'}`} tone="ok" />
        <Kpi href="/leads" icon="funnel" label="Leads" value={String(leads.length)} sub={`${leadsBySource.length} ${leadsBySource.length === 1 ? 'fuente' : 'fuentes'}`} tone="primary" />
        <Kpi href="/leads" icon="users" label="Ya eran clientes" value={String(matched)} sub={leads.length ? `${Math.round((matched / leads.length) * 100)}% de los leads` : 'sin leads'} tone="neutral" />
      </section>

      <section className="panel" aria-labelledby="sales-rep-title">
        <div className="panel-head">
          <h2 id="sales-rep-title">Ventas por período</h2>
          {canExport ? <ExportCsvLink type="ventas" preset={filters.periodo} desde={filters.desde} hasta={filters.hasta} extra={{ personas: filters.personas, equipos: filters.equipos }} /> : null}
        </div>
        {salesByPeriod.length === 0 ? <p className="muted">Sin ventas entregadas en este período.</p> : (
          <div className="an-grid-2">
            <ColumnChart rows={salesByPeriod.map((b) => ({ label: b.label, value: b.amount, sub: `${b.count} ventas` }))} format={money} colorIndex={1} />
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th scope="col">Período</th><th scope="col">Ventas</th><th scope="col">Monto</th></tr></thead>
                <tbody>{salesByPeriod.map((b) => <tr key={b.key}><td>{b.label}</td><td className="small">{b.count}</td><td className="small">{money(b.amount)}</td></tr>)}</tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="leads-rep-title">
        <div className="panel-head">
          <h2 id="leads-rep-title">Leads por fuente</h2>
          {canExport ? <ExportCsvLink type="leads" preset={filters.periodo} desde={filters.desde} hasta={filters.hasta} extra={exportExtra} /> : null}
        </div>
        {leadsBySource.length === 0 ? <p className="muted">Sin leads en este período.</p> : (
          <div className="an-grid-2">
            <Donut rows={leadsBySource.map((b) => ({ label: b.source, value: b.count }))} centerLabel="leads" />
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th scope="col">Fuente</th><th scope="col">Leads</th><th scope="col">Ya eran clientes</th></tr></thead>
                <tbody>{leadsBySource.map((b) => <tr key={b.source}><td>{b.source}</td><td className="small">{b.count}</td><td className="small">{b.matched}</td></tr>)}</tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
