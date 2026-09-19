import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { formatMoney } from '@/lib/money';
import { SALE_STATUS } from '@/lib/commerce-labels';
import { getSale, listSaleItems } from '@/repositories/sales';
import { getQuote } from '@/repositories/quotes';
import { getCustomer } from '@/repositories/customers';
import { listTransitions } from '@/repositories/opportunities';
import { listTasks } from '@/repositories/tasks';
import { listMembers } from '@/repositories/members';
import { uuidSchema } from '@/services/schemas';
import { ConfirmButton, Notice } from '@/components/ui';
import { PrintButton } from '@/components/commerce-forms';
import { cancelSaleAction, deliverSaleAction } from '../actions';

export const metadata: Metadata = { title: 'Venta' };

export default async function SalePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  const sale = await getSale(db, id);
  if (!sale) notFound();

  const [items, quote, customer, transitions, tasks, members, flash] = await Promise.all([
    listSaleItems(db, id), getQuote(db, sale.quoteId), getCustomer(db, sale.customerId), listTransitions(db, 'sale', id),
    can(session, 'tasks:read') ? listTasks(db, { orgId: org.orgId, opportunityId: sale.opportunityId, limit: 50 }) : Promise.resolve([]),
    listMembers(db, org.orgId), readFlash(),
  ]);
  const money = (n: number) => formatMoney(n, sale.currency, org.orgLocale);
  const [label, cls] = SALE_STATUS[sale.status] ?? [sale.status, ''];
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: org.orgTimezone });
  const nameOf = (uid: string | null) => { const m = members.find((x) => x.userId === uid); return m?.fullName ?? m?.email ?? 'Alguien'; };
  const canUpdate = can(session, 'sales:update');
  const isManager = session.permissions['sales:update'] === 'org';
  const followUp = tasks.filter((t) => t.description?.startsWith(`Seguimiento postventa de ${sale.number}`));

  return (
    <>
      <header className="page-head">
        <p className="small no-print"><Link href="/sales">← Ventas</Link>{quote ? <> · <Link href={`/quotes/${quote.id}`}>Cotización {quote.number}</Link></> : null}</p>
        <h1>{sale.number} <span className={`badge ${cls}`}>{label}</span></h1>
        <p className="muted">
          Cliente: {customer ? <Link href={`/customers/${customer.id}`}>{customer.fullName}</Link> : 'No disponible'} · Vendida el {fmt.format(new Date(sale.soldAt))}
          {sale.deliveredAt ? ` · Entregada el ${fmt.format(new Date(sale.deliveredAt))}` : ''}
        </p>
        {sale.status === 'cancelled' ? <p className="muted">Anulada: {sale.cancelReason}</p> : null}
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <section className="panel" aria-labelledby="l-title">
        <div className="panel-head"><h2 id="l-title">Lo vendido</h2><PrintButton /></div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Descripción</th><th scope="col" className="num">Cant.</th><th scope="col" className="num">Precio</th><th scope="col" className="num">Desc.</th><th scope="col" className="num">IVA</th><th scope="col" className="num">Total</th></tr></thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td>{it.description}<div className="small muted">{it.unit}</div></td>
                  <td className="num">{it.quantity.toLocaleString('es')}</td><td className="num">{money(it.unitPrice)}</td>
                  <td className="num">{it.discountPct > 0 ? `${it.discountPct}%` : '—'}</td><td className="num">{it.taxRate > 0 ? `${it.taxRate}%` : '—'}</td>
                  <td className="num">{money(it.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="totals">
          <dt>Subtotal</dt><dd>{money(sale.subtotal)}</dd>
          {sale.discountTotal > 0 ? (<><dt>Descuento</dt><dd>− {money(sale.discountTotal)}</dd></>) : null}
          <dt>IVA</dt><dd>{money(sale.taxTotal)}</dd>
          <dt className="grand">Total</dt><dd className="grand">{money(sale.total)}</dd>
        </dl>
        <p className="hint no-print">Esta venta es una copia fija de la cotización aceptada: ni el catálogo ni nuevas versiones la modifican.</p>
      </section>

      {canUpdate && sale.status !== 'cancelled' ? (
        <section className="panel no-print" aria-labelledby="a-title">
          <div className="panel-head"><h2 id="a-title">Acciones</h2></div>
          <div className="action-bar">
            {sale.status === 'confirmed' ? (
              <form action={deliverSaleAction}><input type="hidden" name="saleId" value={id} /><button className="btn btn-primary" type="submit">Marcar como entregada</button></form>
            ) : null}
            {isManager ? (
              <details>
                <summary className="btn btn-secondary">Anular venta</summary>
                <form action={cancelSaleAction}>
                  <input type="hidden" name="saleId" value={id} />
                  <label className="sr-only" htmlFor="cr">Motivo</label>
                  <input id="cr" name="reason" className="input" maxLength={500} placeholder="Motivo de la anulación (obligatorio)" required />
                  <ConfirmButton message="Anular la venta cancela también el seguimiento pendiente. ¿Continuar?" className="btn btn-danger btn-sm">Confirmar anulación</ConfirmButton>
                </form>
              </details>
            ) : <p className="muted small">Solo un manager o administrador puede anular una venta.</p>}
          </div>
        </section>
      ) : null}

      <div className="detail-grid no-print">
        <section className="panel" aria-labelledby="f-title">
          <div className="panel-head"><h2 id="f-title">Seguimiento postventa</h2></div>
          {followUp.length === 0 ? <p className="muted">No hay tareas de seguimiento visibles para ti.</p> : followUp.map((t) => (
            <div className="task-row" key={t.id}>
              <div className="main"><strong>{t.title}</strong>
                <span className="small muted">{t.status === 'open' ? (t.dueAt ? `Vence ${fmt.format(new Date(t.dueAt))}` : 'Sin fecha') : t.status === 'done' ? 'Completada' : 'Cancelada'}{t.assigneeId ? ` · ${nameOf(t.assigneeId)}` : ' · Sin asignar'}</span></div>
            </div>
          ))}
          <p className="hint">Al registrar la venta se crean 3 tareas: confirmar la entrega, la encuesta de satisfacción y ofrecer la recompra.</p>
        </section>
        <section className="panel" aria-labelledby="h-title">
          <div className="panel-head"><h2 id="h-title">Historial</h2></div>
          <ol className="timeline">
            {transitions.map((t) => (
              <li key={t.id}>
                <strong>{t.fromState ? `${SALE_STATUS[t.fromState]?.[0] ?? t.fromState} → ${SALE_STATUS[t.toState]?.[0] ?? t.toState}` : `Registrada como ${SALE_STATUS[t.toState]?.[0]?.toLowerCase() ?? t.toState}`}</strong>
                {t.reason ? <span className="small">{t.reason}</span> : null}
                <span className="when">{fmt.format(new Date(t.occurredAt))}{t.actorId ? ` · ${nameOf(t.actorId)}` : ''}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
