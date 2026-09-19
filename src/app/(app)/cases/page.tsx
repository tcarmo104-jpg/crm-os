import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { CASE_KIND, CASE_NEXT, CASE_STATUS, PRIORITY } from '@/lib/commerce-labels';
import { listCases } from '@/repositories/sales';
import { getCustomersByIds } from '@/repositories/customers';
import { listMembers } from '@/repositories/members';
import { Notice } from '@/components/ui';
import { changeCaseStatusAction } from './actions';

export const metadata: Metadata = { title: 'Casos de postventa' };

export default async function CasesPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  const openOnly = sp.all !== '1';
  const [cases, members, flash] = await Promise.all([
    can(session, 'cases:read') ? listCases(db, { orgId: org.orgId, openOnly }) : Promise.resolve([]),
    listMembers(db, org.orgId), readFlash(),
  ]);
  const customers = await getCustomersByIds(db, [...new Set(cases.map((c) => c.customerId))]);
  const cName = new Map(customers.map((c) => [c.id, c.fullName]));
  const nameOf = (uid: string | null) => { const m = members.find((x) => x.userId === uid); return uid ? (m?.fullName ?? m?.email ?? 'Alguien') : 'Sin asignar'; };
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeZone: org.orgTimezone });
  const canUpdate = can(session, 'cases:update');
  const back = `/cases${openOnly ? '' : '?all=1'}`;

  return (
    <>
      <header className="page-head">
        <h1>Casos de postventa</h1>
        <p className="muted">Soporte, reclamos, garantías y devoluciones. Abre un caso desde la ficha del cliente.</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}
      <section className="panel" aria-labelledby="c-title">
        <div className="panel-head" style={{ flexWrap: 'wrap', gap: 10 }}>
          <h2 id="c-title">{openOnly ? 'Abiertos' : 'Todos'} ({cases.length})</h2>
          <nav className="tabs" aria-label="Filtro">
            <Link href="/cases" aria-current={openOnly ? 'page' : undefined}>Abiertos</Link>
            <Link href="/cases?all=1" aria-current={!openOnly ? 'page' : undefined}>Todos</Link>
          </nav>
        </div>
        {cases.length === 0 ? <div className="empty"><p><strong>{openOnly ? 'No hay casos abiertos.' : 'Aún no hay casos.'}</strong></p></div> : cases.map((c) => {
          const [label, cls] = CASE_STATUS[c.status] ?? [c.status, ''];
          return (
            <div className="task-row" key={c.id}>
              <div className="main">
                <span><strong>{c.number}</strong> · {c.title} <span className={`badge ${cls}`}>{label}</span>{' '}
                  {c.priority === 'urgent' || c.priority === 'high' ? <span className="badge badge-warn">{PRIORITY[c.priority]}</span> : null}</span>
                <span className="small muted">
                  <Link href={`/customers/${c.customerId}`}>{cName.get(c.customerId) ?? 'Cliente'}</Link> · {CASE_KIND[c.kind] ?? c.kind} · {nameOf(c.assigneeId)} · {fmt.format(new Date(c.createdAt))}
                </span>
                {c.description ? <span className="small">{c.description}</span> : null}
                {c.resolution ? <span className="small"><strong>Solución:</strong> {c.resolution}</span> : null}
              </div>
              {canUpdate ? (
                <div className="acts">
                  {(CASE_NEXT[c.status] ?? []).map((n) => (
                    <details key={n.to}>
                      <summary className="btn btn-secondary btn-sm">{n.label}</summary>
                      <form action={changeCaseStatusAction} className="stack" style={{ marginTop: 6 }}>
                        <input type="hidden" name="caseId" value={c.id} /><input type="hidden" name="to" value={n.to} /><input type="hidden" name="returnTo" value={back} />
                        <label className="sr-only" htmlFor={`n-${c.id}-${n.to}`}>{n.to === 'resolved' ? 'Solución' : 'Nota'}</label>
                        <input id={`n-${c.id}-${n.to}`} name="note" className="input" maxLength={2000} placeholder={n.to === 'resolved' ? 'Cómo se resolvió (obligatorio)' : 'Nota (opcional)'} required={n.to === 'resolved'} />
                        <button className="btn btn-primary btn-sm" type="submit">Confirmar</button>
                      </form>
                    </details>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </section>
    </>
  );
}
