import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { listCustomers, listIdentifiers } from '@/repositories/customers';
import { listMembers } from '@/repositories/members';
import { Notice } from '@/components/ui';

export const metadata: Metadata = { title: 'Clientes' };

type SP = Promise<{ q?: string; owner?: string; cursor?: string }>;

const idLabel: Record<string, string> = { phone: 'Tel.', email: 'Correo', instagram: 'IG', facebook: 'FB', external: 'ID' };

export default async function CustomersPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  const seesAll = session.permissions['customers:read'] === 'org';
  const owner = sp.owner === 'mine' || sp.owner === 'none' ? sp.owner : 'all';
  const q = (sp.q ?? '').slice(0, 80);

  const [page, members, flash] = await Promise.all([
    can(session, 'customers:read')
      ? listCustomers(db, { orgId: org.orgId, q, owner, userId: session.user.id, cursor: sp.cursor })
      : Promise.resolve({ items: [], nextCursor: null }),
    listMembers(db, org.orgId),
    readFlash(),
  ]);
  const identifiers = await listIdentifiers(db, page.items.map((c) => c.id));
  const byCustomer = new Map<string, typeof identifiers>();
  for (const i of identifiers) byCustomer.set(i.customerId, [...(byCustomer.get(i.customerId) ?? []), i]);
  const names = new Map(members.map((m) => [m.userId, m.fullName ?? m.email ?? 'Sin nombre']));
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeZone: org.orgTimezone });

  const next = new URLSearchParams();
  if (q) next.set('q', q);
  if (owner !== 'all') next.set('owner', owner);
  if (page.nextCursor) next.set('cursor', page.nextCursor);

  return (
    <>
      <header className="page-head">
        <h1>Clientes</h1>
        <p className="muted">
          {seesAll ? 'Todos los clientes de la organización.' : 'Los clientes que tienes asignados.'}
        </p>
      </header>

      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <section className="panel" aria-label="Buscar y filtrar">
        <form method="get" className="inline-form" role="search">
          <label className="sr-only" htmlFor="q">Buscar</label>
          <input id="q" name="q" className="input" defaultValue={q} placeholder="Nombre, teléfono o correo" maxLength={80} />
          {seesAll ? (
            <>
              <label className="sr-only" htmlFor="owner">Responsable</label>
              <select id="owner" name="owner" className="select select-sm" defaultValue={owner}>
                <option value="all">Todos</option><option value="mine">Solo míos</option><option value="none">Sin asignar</option>
              </select>
            </>
          ) : null}
          <button className="btn btn-secondary" type="submit">Buscar</button>
          {can(session, 'customers:create') ? <Link className="btn btn-primary" href="/customers/new">Nuevo cliente</Link> : null}
        </form>
      </section>

      <section className="panel" aria-labelledby="list-title">
        <div className="panel-head"><h2 id="list-title">{q ? 'Resultados' : 'Lista'}</h2></div>
        {page.items.length === 0 ? (
          <div className="empty">
            <p><strong>{q ? 'No encontramos clientes con esa búsqueda.' : 'Aún no hay clientes.'}</strong></p>
            <p className="muted">
              {q ? 'Prueba con otro nombre, o con el teléfono o correo.' : <>Crea uno con «Nuevo cliente» o <Link href="/leads/import">importa un archivo CSV</Link>.</>}
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Cliente</th><th scope="col">Contacto</th><th scope="col">Responsable</th>
                  <th scope="col">Ciudad</th><th scope="col">Desde</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((c) => {
                  const ids = (byCustomer.get(c.id) ?? []).slice(0, 2);
                  return (
                    <tr key={c.id}>
                      <td>
                        <Link href={`/customers/${c.id}`}><strong>{c.fullName}</strong></Link>{' '}
                        {c.type === 'company' ? <span className="badge">Empresa</span> : null}{' '}
                        {c.doNotContact ? <span className="badge">No contactar</span> : null}
                      </td>
                      <td className="small">{ids.map((i) => <div key={i.id}>{idLabel[i.type] ?? i.type}: {i.value}</div>)}</td>
                      <td>{c.ownerId ? (names.get(c.ownerId) ?? '—') : <span className="muted">Sin asignar</span>}</td>
                      <td>{c.city ?? <span className="muted">—</span>}</td>
                      <td>{fmt.format(new Date(c.createdAt))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {page.nextCursor ? <p><Link className="btn btn-secondary" href={`/customers?${next.toString()}`}>Ver más</Link></p> : null}
      </section>
    </>
  );
}
