import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { listCitiesUsed, listCustomers, listIdentifiers } from '@/repositories/customers';
import { listMembers } from '@/repositories/members';
import { listTags, tagsByCustomer } from '@/repositories/inbox';
import { Notice } from '@/components/ui';
import { Tag } from '@/components/tags';
import { FilterSelect, SearchInput } from '@/components/filters';

export const metadata: Metadata = { title: 'Clientes' };

type SP = Promise<{ q?: string; owner?: string; tag?: string; city?: string; type?: string; dnc?: string; cursor?: string }>;

const idLabel: Record<string, string> = { phone: 'Tel.', email: 'Correo', instagram: 'IG', facebook: 'FB', external: 'ID' };

export default async function CustomersPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  const seesAll = session.permissions['customers:read'] === 'org';
  const owner = sp.owner === 'mine' || sp.owner === 'none' ? sp.owner : 'all';
  const q = (sp.q ?? '').slice(0, 80);
  const type = sp.type === 'person' || sp.type === 'company' ? sp.type : undefined;
  const doNotContact = sp.dnc === '1' ? true : undefined;

  const [page, members, flash, tags, cities] = await Promise.all([
    can(session, 'customers:read')
      ? listCustomers(db, { orgId: org.orgId, q, owner, userId: session.user.id, cursor: sp.cursor, tagId: sp.tag || undefined, city: sp.city || undefined, type, doNotContact })
      : Promise.resolve({ items: [], nextCursor: null }),
    listMembers(db, org.orgId),
    readFlash(),
    listTags(db, org.orgId),
    listCitiesUsed(db, org.orgId),
  ]);
  const identifiers = await listIdentifiers(db, page.items.map((c) => c.id));
  const byCustomer = new Map<string, typeof identifiers>();
  for (const i of identifiers) byCustomer.set(i.customerId, [...(byCustomer.get(i.customerId) ?? []), i]);
  const tagsMap = await tagsByCustomer(db, page.items.map((c) => c.id));
  const names = new Map(members.map((m) => [m.userId, m.fullName ?? m.email ?? 'Sin nombre']));
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeZone: org.orgTimezone });

  const qs: Record<string, string> = {};
  if (q) qs.q = q;
  if (owner !== 'all') qs.owner = owner;
  if (sp.tag) qs.tag = sp.tag;
  if (sp.city) qs.city = sp.city;
  if (type) qs.type = type;
  if (doNotContact) qs.dnc = '1';
  const hasFilters = Object.keys(qs).length > 0;
  if (page.nextCursor) qs.cursor = page.nextCursor;

  return (
    <>
      <header className="page-head">
        <h1>Clientes</h1>
        <p className="muted">
          {seesAll ? 'Todos los clientes de la organización.' : 'Los clientes que tienes asignados.'}
        </p>
      </header>

      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <div className="flt-bar">
        <SearchInput basePath="/customers" initial={q} placeholder="Nombre, teléfono o correo" />
        {seesAll ? <FilterSelect basePath="/customers" param="owner" label="Responsable" value={owner === 'all' ? '' : owner} allLabel="Todos" options={[{ value: 'mine', label: 'Solo míos' }, { value: 'none', label: 'Sin asignar' }]} /> : null}
        <FilterSelect basePath="/customers" param="type" label="Tipo" value={type ?? ''} options={[{ value: 'person', label: 'Persona' }, { value: 'company', label: 'Empresa' }]} />
        <FilterSelect basePath="/customers" param="tag" label="Etiqueta" value={sp.tag ?? ''} options={tags.map((t) => ({ value: t.id, label: t.name }))} />
        <FilterSelect basePath="/customers" param="city" label="Ciudad" value={sp.city ?? ''} options={cities.map((c) => ({ value: c, label: c }))} />
        <FilterSelect basePath="/customers" param="dnc" label="Contacto" value={sp.dnc ?? ''} allLabel="Todos" options={[{ value: '1', label: 'No contactar' }]} />
        {can(session, 'customers:create') ? <Link className="btn btn-primary" href="/customers/new" style={{ marginLeft: 'auto' }}>Nuevo cliente</Link> : null}
      </div>
      {hasFilters ? <p className="hint"><Link href="/customers">Quitar filtros</Link></p> : null}

      <section className="panel" aria-labelledby="list-title">
        <div className="panel-head"><h2 id="list-title">{hasFilters ? 'Resultados' : 'Lista'}</h2></div>
        {page.items.length === 0 ? (
          <div className="empty-state">
            <strong>{hasFilters ? 'No encontramos clientes con estos filtros.' : 'Aún no hay clientes.'}</strong>
            <p>{hasFilters ? 'Prueba con otro nombre, u otro filtro.' : <>Crea uno con «Nuevo cliente» o <Link href="/leads/import">importa un archivo CSV</Link>.</>}</p>
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
                  const cTags = tagsMap.get(c.id) ?? [];
                  return (
                    <tr key={c.id}>
                      <td>
                        <Link href={`/customers/${c.id}`}><strong>{c.fullName}</strong></Link>{' '}
                        {c.type === 'company' ? <span className="badge badge-neutral">Empresa</span> : null}{' '}
                        {c.doNotContact ? <span className="badge badge-danger">No contactar</span> : null}
                        {cTags.length > 0 ? <div className="tag-row" style={{ marginTop: 4 }}>{cTags.slice(0, 3).map((t) => <Tag key={t.id} tag={t} />)}</div> : null}
                      </td>
                      <td className="small">{ids.map((i) => <div key={i.id}>{idLabel[i.type] ?? i.type}: {i.value}</div>)}</td>
                      <td className="small">{c.ownerId ? (names.get(c.ownerId) ?? '—') : <span className="muted">Sin asignar</span>}</td>
                      <td className="small">{c.city ?? <span className="muted">—</span>}</td>
                      <td className="small">{fmt.format(new Date(c.createdAt))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {page.nextCursor ? <p><Link className="btn btn-secondary" href={`/customers?${new URLSearchParams(qs)}`}>Ver más</Link></p> : null}
      </section>
    </>
  );
}
