import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { formatMoney } from '@/lib/money';
import { dayKey } from '@/lib/time';
import { QUOTE_STATUS } from '@/lib/commerce-labels';
import { listQuotes } from '@/repositories/quotes';
import { getCustomersByIds } from '@/repositories/customers';

export const metadata: Metadata = { title: 'Cotizaciones' };

export default async function QuotesPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  const page = can(session, 'quotes:read') ? await listQuotes(db, { orgId: org.orgId, cursor: sp.cursor }) : { items: [], nextCursor: null };
  const customers = await getCustomersByIds(db, [...new Set(page.items.map((x) => x.customerId))]);
  const cName = new Map(customers.map((c) => [c.id, c.fullName]));
  const today = dayKey(new Date(), org.orgTimezone);
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeZone: org.orgTimezone });

  return (
    <>
      <header className="page-head">
        <h1>Cotizaciones</h1>
        <p className="muted">Se crean desde una oportunidad. Una cotización enviada no se modifica: si algo cambia, se crea una nueva versión.</p>
      </header>
      <section className="panel" aria-labelledby="q-title">
        <div className="panel-head"><h2 id="q-title">Recientes</h2></div>
        {page.items.length === 0 ? (
          <div className="empty"><p><strong>Aún no hay cotizaciones.</strong></p><p className="muted">Abre una <Link href="/opportunities">oportunidad</Link> y pulsa «Nueva cotización».</p></div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Número</th><th scope="col">Cliente</th><th scope="col">Estado</th><th scope="col">Vence</th><th scope="col" className="num">Total</th></tr></thead>
              <tbody>
                {page.items.map((x) => {
                  const expired = x.status === 'sent' && x.validUntil !== null && x.validUntil < today;
                  const [label, cls] = QUOTE_STATUS[x.status] ?? [x.status, ''];
                  return (
                    <tr key={x.id}>
                      <td><Link href={`/quotes/${x.id}`}><strong>{x.number}</strong>{x.version > 1 ? ` v${x.version}` : ''}</Link></td>
                      <td>{cName.get(x.customerId) ?? <span className="muted">No disponible</span>}</td>
                      <td><span className={`badge ${cls}`}>{label}</span> {expired ? <span className="badge badge-danger">Vencida</span> : null}</td>
                      <td>{x.validUntil ? fmt.format(new Date(`${x.validUntil}T12:00:00`)) : '—'}</td>
                      <td className="num">{formatMoney(x.total, x.currency, org.orgLocale)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {page.nextCursor ? <p><Link className="btn btn-secondary" href={`/quotes?cursor=${encodeURIComponent(page.nextCursor)}`}>Ver más</Link></p> : null}
      </section>
    </>
  );
}
