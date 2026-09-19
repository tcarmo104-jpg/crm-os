import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { listPendingReviews } from '@/repositories/reviews';
import { getCustomersByIds, listIdentifiers } from '@/repositories/customers';
import { listMembers } from '@/repositories/members';
import type { CustomerRow, IdentifierRow } from '@/lib/types';
import { ConfirmButton, Notice } from '@/components/ui';
import { dismissAction, mergeAction } from './actions';

export const metadata: Metadata = { title: 'Duplicados' };

const kindLabel = {
  possible_duplicate: 'Mismo nombre, sin datos de contacto en común',
  identifier_conflict: 'Un mismo mensaje trajo datos de dos clientes distintos',
  duplicate_attempt: 'Alguien intentó crear un contacto que ya existía',
} as const;

export default async function DuplicatesPage() {
  const session = (await getSession())!;
  const org = session.active!;

  if (session.permissions['customers:update'] !== 'org') {
    return (
      <section className="panel">
        <h1>Duplicados</h1>
        <p className="muted">Solo managers y administradores pueden revisar posibles duplicados.</p>
      </section>
    );
  }

  const db = await createClient();
  const [reviews, members, flash] = await Promise.all([listPendingReviews(db, org.orgId), listMembers(db, org.orgId), readFlash()]);
  const ids = [...new Set(reviews.flatMap((r) => [r.customerId, ...(r.candidateId ? [r.candidateId] : [])]))];
  const [customers, identifiers] = await Promise.all([getCustomersByIds(db, ids), listIdentifiers(db, ids)]);
  const byId = new Map(customers.map((c) => [c.id, c]));
  const idsBy = new Map<string, IdentifierRow[]>();
  for (const i of identifiers) idsBy.set(i.customerId, [...(idsBy.get(i.customerId) ?? []), i]);
  const person = (uid: string | null) => (uid ? (members.find((m) => m.userId === uid)?.fullName ?? members.find((m) => m.userId === uid)?.email ?? 'Alguien') : null);
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeZone: org.orgTimezone });

  const Card = ({ c }: { c: CustomerRow }) => (
    <div className="stack">
      <Link href={`/customers/${c.id}`}><strong>{c.fullName}</strong></Link>
      <span className="small muted">Desde {fmt.format(new Date(c.firstContactAt))} · {c.ownerId ? (person(c.ownerId) ?? '—') : 'Sin asignar'}</span>
      <ul className="id-list small">{(idsBy.get(c.id) ?? []).map((i) => <li key={i.id}>{i.type}: {i.value}</li>)}</ul>
    </div>
  );

  return (
    <>
      <header className="page-head">
        <h1>Duplicados por revisar</h1>
        <p className="muted">
          Nunca fusionamos automáticamente: decides tú. Al fusionar se conserva el cliente más antiguo y se unen contactos, leads y
          actividad. Si alguno pidió «no contactar», el resultado también lo tendrá.
        </p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      {reviews.length === 0 ? (
        <section className="panel"><div className="empty"><p><strong>No hay nada por revisar.</strong></p></div></section>
      ) : reviews.map((r) => {
        const a = byId.get(r.customerId);
        const b = r.candidateId ? byId.get(r.candidateId) : undefined;
        if (!a) return null;
        const pair: [CustomerRow, CustomerRow] | null = b
          ? (new Date(a.firstContactAt) <= new Date(b.firstContactAt) ? [a, b] : [b, a])
          : null;
        return (
          <section key={r.id} className="review-card" aria-label={kindLabel[r.kind]}>
            <div className="panel-head">
              <strong>{kindLabel[r.kind]}</strong>
              <span className="muted small">{fmt.format(new Date(r.createdAt))}</span>
            </div>
            {pair ? (
              <>
                <div className="review-pair"><Card c={pair[0]} /><Card c={pair[1]} /></div>
                <div className="inline-form">
                  <form action={mergeAction}>
                    <input type="hidden" name="keepId" value={pair[0].id} />
                    <input type="hidden" name="dropId" value={pair[1].id} />
                    <ConfirmButton className="btn btn-primary btn-sm" message={`¿Fusionar «${pair[1].fullName}» dentro de «${pair[0].fullName}»? No se puede deshacer.`}>
                      Son la misma persona: fusionar
                    </ConfirmButton>
                  </form>
                  <form action={dismissAction}>
                    <input type="hidden" name="reviewId" value={r.id} />
                    <button className="btn btn-secondary btn-sm" type="submit">No son la misma persona</button>
                  </form>
                </div>
              </>
            ) : (
              <>
                <Card c={a} />
                <p className="small muted">
                  {person(r.createdBy) ? `${person(r.createdBy)} intentó` : 'Alguien intentó'} registrar este contacto, pero le pertenece a otra persona.
                  Nada se duplicó. Puedes reasignarlo desde su ficha si corresponde.
                </p>
                <form action={dismissAction}>
                  <input type="hidden" name="reviewId" value={r.id} />
                  <button className="btn btn-secondary btn-sm" type="submit">Marcar como revisado</button>
                </form>
              </>
            )}
          </section>
        );
      })}
    </>
  );
}
