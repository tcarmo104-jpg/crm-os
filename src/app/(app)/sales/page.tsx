import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { formatMoney } from '@/lib/money';
import { SALE_STATUS } from '@/lib/commerce-labels';
import { listSales } from '@/repositories/sales';
import { getCustomersByIds } from '@/repositories/customers';

export const metadata: Metadata = { title: 'Ventas' };

export default async function SalesPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  const page = can(session, 'sales:read') ? await listSales(db, { orgId: org.orgId, cursor: sp.cursor }) : { items: [], nextCursor: null };
  const customers = await getCustomersByIds(db, [...new Set(page.items.map((s) => s.customerId))]);
  const cName = new Map(customers.map((c) => [c.id, c.fullName]));
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeZone: org.orgTimezone });
  const active = page.items.filter((s) => s.status !== 'cancelled');
  const total = active.reduce((sum, s) => sum + s.total * 100, 0) / 100;

  return (
    <>
      <header className="page-head">
        <h1>Ventas</h1>
        <p className="muted">Cada venta guarda una copia de la cotización aceptada: nada posterior la altera. Se registran desde una cotización aceptada.</p>
      </header>
      {active.length > 0 ? (
        <div className="stats" role="group" aria-label="Resumen">
          <div className="stat"><span className="n">{active.length}</span><span className="l">Ventas activas (en esta página)</span></div>
          <div className="stat"><span className="n">{formatMoney(total, active[0]?.currency ?? 'COP', org.orgLocale)}</span><span className="l">Valor total con IVA</span></div>
        </div>
      ) : null}
      <section className="panel" aria-labelledby="s-title">
        <div className="panel-head"><h2 id="s-title">Recientes</h2></div>
        {page.items.length === 0 ? (
          <div className="empty"><p><strong>Aún no hay ventas.</strong></p><p className="muted">Acepta una <Link href="/quotes">cotización</Link> y regístrala como venta.</p></div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Número</th><th scope="col">Cliente</th><th scope="col">Fecha</th><th scope="col">Estado</th><th scope="col" className="num">Total</th></tr></thead>
              <tbody>
                {page.items.map((s) => {
                  const [label, cls] = SALE_STATUS[s.status] ?? [s.status, ''];
                  return (
                    <tr key={s.id}>
                      <td><Link href={`/sales/${s.id}`}><strong>{s.number}</strong></Link></td>
                      <td>{cName.get(s.customerId) ?? <span className="muted">No disponible</span>}</td>
                      <td>{fmt.format(new Date(s.soldAt))}</td>
                      <td><span className={`badge ${cls}`}>{label}</span></td>
                      <td className="num">{formatMoney(s.total, s.currency, org.orgLocale)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {page.nextCursor ? <p><Link className="btn btn-secondary" href={`/sales?cursor=${encodeURIComponent(page.nextCursor)}`}>Ver más</Link></p> : null}
      </section>
    </>
  );
}
