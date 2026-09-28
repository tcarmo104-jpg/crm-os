import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listSales } from '@/repositories/sales';
import { listLeads } from '@/repositories/leads';
import { parsePeriod, resolveDateRange, groupSalesByPeriod, groupLeadsBySource } from '@/lib/analytics';
import { formatMoney } from '@/lib/money';
import { Notice } from '@/components/ui';
import { PeriodFilter, ExportCsvLink } from '@/components/period-filter';

export const metadata: Metadata = { title: 'Reportes' };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ periodo?: string; desde?: string; hasta?: string }> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'reports:read')) return <><header className="page-head"><h1>Reportes</h1></header><Notice kind="error">No tienes acceso a este módulo.</Notice></>;
  const db = await createClient();
  const canExport = can(session, 'reports:export');

  const { preset, desde, hasta } = parsePeriod(sp);
  const range = resolveDateRange(preset, new Date(), org.orgTimezone, { from: desde, to: hasta });

  const [sales, leads] = await Promise.all([
    listSales(db, { orgId: org.orgId, soldFrom: range.from, soldTo: range.to, status: 'delivered', limit: 2000 }),
    listLeads(db, { orgId: org.orgId, from: range.from, to: range.to, limit: 2000 }),
  ]);
  const salesByPeriod = groupSalesByPeriod(sales.items, org.orgTimezone, 'month');
  const leadsBySource = groupLeadsBySource(leads.items.map((l) => ({ source: l.source, resolution: l.resolution })));
  const money = (n: number) => formatMoney(n, null, org.orgLocale);

  return (
    <>
      <header className="page-head">
        <h1>Reportes</h1>
        <p className="muted">Ventas por período y leads por fuente, para el rango que elijas.</p>
      </header>

      <div className="flt-bar"><PeriodFilter basePath="/reports" preset={preset} desde={desde} hasta={hasta} /></div>

      <section className="panel" aria-labelledby="sales-rep-title">
        <div className="panel-head">
          <h2 id="sales-rep-title">Ventas por período</h2>
          {canExport ? <ExportCsvLink type="ventas" preset={preset} desde={desde} hasta={hasta} /> : null}
        </div>
        {salesByPeriod.length === 0 ? <p className="muted">Sin ventas entregadas en este período.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Período</th><th scope="col">Ventas</th><th scope="col">Monto</th></tr></thead>
              <tbody>{salesByPeriod.map((b) => <tr key={b.key}><td>{b.label}</td><td className="small">{b.count}</td><td className="small">{money(b.amount)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="leads-rep-title">
        <div className="panel-head">
          <h2 id="leads-rep-title">Leads por fuente</h2>
          {canExport ? <ExportCsvLink type="leads" preset={preset} desde={desde} hasta={hasta} /> : null}
        </div>
        {leadsBySource.length === 0 ? <p className="muted">Sin leads en este período.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Fuente</th><th scope="col">Leads</th><th scope="col">Ya eran clientes</th></tr></thead>
              <tbody>{leadsBySource.map((b) => <tr key={b.source}><td>{b.source}</td><td className="small">{b.count}</td><td className="small">{b.matched}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
