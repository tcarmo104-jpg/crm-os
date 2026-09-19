import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { formatMoney } from '@/lib/money';
import { dayKey } from '@/lib/time';
import { QUOTE_STATUS } from '@/lib/commerce-labels';
import { getQuote, listItems, listVersions } from '@/repositories/quotes';
import { getOpportunity, listTransitions } from '@/repositories/opportunities';
import { getCustomer } from '@/repositories/customers';
import { listProducts } from '@/repositories/products';
import { getSaleByQuote } from '@/repositories/sales';
import { listMembers } from '@/repositories/members';
import { uuidSchema } from '@/services/schemas';
import { ConfirmButton, Notice } from '@/components/ui';
import { AddItemForm, PrintButton, QuoteHeaderForm } from '@/components/commerce-forms';
import {
  acceptQuoteAction, createSaleAction, rejectQuoteAction, removeItemAction, reviseQuoteAction, sendQuoteAction, updateItemAction,
} from '../actions';

export const metadata: Metadata = { title: 'Cotización' };

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();

  const quote = await getQuote(db, id);
  if (!quote) notFound();

  const draft = quote.status === 'draft';
  const canEdit = can(session, 'quotes:update');
  const [items, versions, opp, customer, catalog, sale, transitions, members, flash] = await Promise.all([
    listItems(db, id), listVersions(db, org.orgId, quote.number), getOpportunity(db, quote.opportunityId), getCustomer(db, quote.customerId),
    draft && canEdit ? listProducts(db, { orgId: org.orgId, activeOnly: true }) : Promise.resolve([]),
    quote.status === 'accepted' ? getSaleByQuote(db, id) : Promise.resolve(null),
    listTransitions(db, 'quote', id), listMembers(db, org.orgId), readFlash(),
  ]);

  const money = (n: number) => formatMoney(n, quote.currency, org.orgLocale);
  const today = dayKey(new Date(), org.orgTimezone);
  const expired = quote.status === 'sent' && quote.validUntil !== null && quote.validUntil < today;
  const [label, cls] = QUOTE_STATUS[quote.status] ?? [quote.status, ''];
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: org.orgTimezone });
  const fmtDay = new Intl.DateTimeFormat('es', { dateStyle: 'long', timeZone: org.orgTimezone });
  const nameOf = (uid: string | null) => { const m = members.find((x) => x.userId === uid); return m?.fullName ?? m?.email ?? 'Alguien'; };
  const latest = versions[0];
  const oppOpen = opp?.status === 'open';
  const back = `/quotes/${id}`;

  return (
    <>
      <header className="page-head">
        <p className="small no-print"><Link href="/quotes">← Cotizaciones</Link>{opp ? <> · <Link href={`/opportunities/${opp.id}`}>Oportunidad: {opp.title}</Link></> : null}</p>
        <h1>{quote.number}{quote.version > 1 ? ` · versión ${quote.version}` : ''} <span className={`badge ${cls}`}>{label}</span> {expired ? <span className="badge badge-danger">Vencida</span> : null}</h1>
        <p className="muted">
          Cliente: {customer ? <Link href={`/customers/${customer.id}`}>{customer.fullName}</Link> : 'No disponible'} · Válida hasta {quote.validUntil ? fmtDay.format(new Date(`${quote.validUntil}T12:00:00`)) : '—'}
        </p>
        {quote.status === 'superseded' && latest && latest.id !== quote.id ? <p className="muted no-print">Esta versión fue reemplazada. <Link href={`/quotes/${latest.id}`}>Ver la versión {latest.version}</Link>.</p> : null}
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <section className="panel" aria-labelledby="lines-title">
        <div className="panel-head"><h2 id="lines-title">Detalle</h2><PrintButton /></div>
        {items.length === 0 ? <p className="muted">Todavía no hay líneas.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Descripción</th><th scope="col" className="num">Cant.</th><th scope="col" className="num">Precio</th><th scope="col" className="num">Desc.</th><th scope="col" className="num">IVA</th><th scope="col" className="num">Total</th></tr></thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td>
                      {it.description}<div className="small muted">{it.unit}</div>
                      {draft && canEdit ? (
                        <details className="no-print">
                          <summary className="small">Editar</summary>
                          <form action={updateItemAction} className="stack">
                            <input type="hidden" name="quoteId" value={id} /><input type="hidden" name="itemId" value={it.id} />
                            <div className="grid-3">
                              <div><label className="sr-only" htmlFor={`q-${it.id}`}>Cantidad</label><input id={`q-${it.id}`} name="quantity" className="input" defaultValue={String(it.quantity)} inputMode="decimal" required /></div>
                              <div><label className="sr-only" htmlFor={`p-${it.id}`}>Precio</label><input id={`p-${it.id}`} name="unitPrice" className="input" defaultValue={String(it.unitPrice)} inputMode="decimal" required /></div>
                              <div><label className="sr-only" htmlFor={`d-${it.id}`}>Descuento</label><input id={`d-${it.id}`} name="discountPct" className="input" defaultValue={String(it.discountPct)} inputMode="decimal" /></div>
                            </div>
                            <button className="btn btn-secondary btn-sm" type="submit">Guardar línea</button>
                          </form>
                          <form action={removeItemAction}>
                            <input type="hidden" name="quoteId" value={id} /><input type="hidden" name="itemId" value={it.id} />
                            <ConfirmButton message="¿Quitar esta línea?" className="btn btn-ghost btn-sm">Quitar línea</ConfirmButton>
                          </form>
                        </details>
                      ) : null}
                    </td>
                    <td className="num">{it.quantity.toLocaleString('es')}</td>
                    <td className="num">{money(it.unitPrice)}</td>
                    <td className="num">{it.discountPct > 0 ? `${it.discountPct}%` : '—'}</td>
                    <td className="num">{it.taxRate > 0 ? `${it.taxRate}%` : '—'}</td>
                    <td className="num">{money(it.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <dl className="totals">
          <dt>Subtotal</dt><dd>{money(quote.subtotal)}</dd>
          {quote.discountTotal > 0 ? (<><dt>Descuento</dt><dd>− {money(quote.discountTotal)}</dd></>) : null}
          <dt>IVA</dt><dd>{money(quote.taxTotal)}</dd>
          <dt className="grand">Total</dt><dd className="grand">{money(quote.total)}</dd>
        </dl>
        {quote.notes ? <p className="small"><strong>Notas:</strong> {quote.notes}</p> : null}
      </section>

      {canEdit ? (
        <section className="panel no-print" aria-labelledby="actions-title">
          <div className="panel-head"><h2 id="actions-title">Acciones</h2></div>
          <div className="action-bar">
            {draft ? (
              <form action={sendQuoteAction}>
                <input type="hidden" name="quoteId" value={id} />
                <ConfirmButton message="Al enviarla, la cotización ya no se puede modificar. ¿Enviar?" className="btn btn-primary">Enviar cotización</ConfirmButton>
              </form>
            ) : null}
            {quote.status === 'sent' ? (
              <>
                <form action={acceptQuoteAction}><input type="hidden" name="quoteId" value={id} /><button className="btn btn-primary" type="submit">El cliente la aceptó</button></form>
                <details>
                  <summary className="btn btn-secondary">El cliente la rechazó</summary>
                  <form action={rejectQuoteAction}>
                    <input type="hidden" name="quoteId" value={id} />
                    <label className="sr-only" htmlFor="rj">Motivo</label>
                    <input id="rj" name="reason" className="input" maxLength={500} placeholder="Motivo (opcional)" />
                    <button className="btn btn-secondary btn-sm" type="submit">Confirmar rechazo</button>
                  </form>
                </details>
              </>
            ) : null}
            {(quote.status === 'sent' || quote.status === 'rejected') && oppOpen && can(session, 'quotes:create') ? (
              <form action={reviseQuoteAction}><input type="hidden" name="quoteId" value={id} /><button className="btn btn-secondary" type="submit">Crear nueva versión</button></form>
            ) : null}
            {quote.status === 'accepted' ? (
              sale ? <Link className="btn btn-primary" href={`/sales/${sale.id}`}>Ver la venta {sale.number}</Link>
              : can(session, 'sales:create') ? (
                <form action={createSaleAction}>
                  <input type="hidden" name="quoteId" value={id} />
                  <ConfirmButton message="Se registrará la venta con una copia de esta cotización, la oportunidad quedará ganada y se abrirá el seguimiento postventa. ¿Continuar?" className="btn btn-primary">Registrar venta</ConfirmButton>
                </form>
              ) : <p className="muted">Un manager, administrador o sales manager debe registrar la venta.</p>
            ) : null}
          </div>
        </section>
      ) : null}

      {draft && canEdit ? (
        <div className="detail-grid no-print">
          <section className="panel" aria-labelledby="add-title"><div className="panel-head"><h2 id="add-title">Agregar línea</h2></div><AddItemForm quoteId={id} products={catalog} /></section>
          <section className="panel" aria-labelledby="head-title"><div className="panel-head"><h2 id="head-title">Vigencia y notas</h2></div><QuoteHeaderForm quoteId={id} validUntil={quote.validUntil} notes={quote.notes} /></section>
        </div>
      ) : null}

      <section className="panel no-print" aria-labelledby="hist-title">
        <div className="panel-head"><h2 id="hist-title">Historial</h2></div>
        <ol className="timeline">
          {transitions.map((t) => (
            <li key={t.id}>
              <strong>{t.fromState ? `${QUOTE_STATUS[t.fromState]?.[0] ?? t.fromState} → ${QUOTE_STATUS[t.toState]?.[0] ?? t.toState}` : `Creada como ${QUOTE_STATUS[t.toState]?.[0]?.toLowerCase() ?? t.toState}`}</strong>
              {t.reason ? <span className="small">{t.reason}</span> : null}
              <span className="when">{fmt.format(new Date(t.occurredAt))}{t.actorId ? ` · ${nameOf(t.actorId)}` : ''}</span>
            </li>
          ))}
        </ol>
        {versions.length > 1 ? (
          <p className="small">Versiones: {versions.map((v) => <span key={v.id}><Link href={`/quotes/${v.id}`}>v{v.version}</Link>{' '}</span>)}</p>
        ) : null}
      </section>
    </>
  );
}
