import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { canConvert, LEAD_RESOLUTION_LABEL, LEAD_STATUS_BADGE, LEAD_STATUS_LABEL, LEAD_STATUSES, nextLeadStatuses } from '@/lib/leads';
import { listLeads, listLeadSources } from '@/repositories/leads';
import { getCustomersByIds } from '@/repositories/customers';
import { listMembers } from '@/repositories/members';
import { tagsByCustomer } from '@/repositories/inbox';
import { Notice } from '@/components/ui';
import { Tag } from '@/components/tags';
import { FilterSelect, SearchInput, DateFilter } from '@/components/filters';
import { NewLeadModal } from '@/components/leads/LeadModal';
import { changeLeadStatusAction, convertLeadAction } from './lead-actions';

export const metadata: Metadata = { title: 'Leads' };

type Params = { estado?: string; fuente?: string; resultado?: string; responsable?: string; desde?: string; hasta?: string; q?: string; cursor?: string };

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();

  const status = LEAD_STATUSES.includes((sp.estado ?? '') as never) ? sp.estado : undefined;
  const resolution = ['created', 'matched', 'review', 'conflict'].includes(sp.resultado ?? '') ? sp.resultado : undefined;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.desde ?? '') ? `${sp.desde}T00:00:00.000Z` : undefined;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.hasta ?? '') ? `${sp.hasta}T23:59:59.999Z` : undefined;
  const q = (sp.q ?? '').trim() || undefined;

  const page = can(session, 'leads:read')
    ? await listLeads(db, {
        orgId: org.orgId, cursor: sp.cursor, status, source: sp.fuente || undefined, resolution, from, to, q,
        ownerId: sp.responsable && sp.responsable !== 'sin_asignar' ? sp.responsable : undefined, unassigned: sp.responsable === 'sin_asignar',
      })
    : { items: [], nextCursor: null };
  const [customers, members, flash, sources, tagsMap] = await Promise.all([
    getCustomersByIds(db, [...new Set(page.items.map((l) => l.customerId))]),
    listMembers(db, org.orgId),
    readFlash(),
    can(session, 'leads:create') ? listLeadSources(db, org.orgId) : Promise.resolve([]),
    tagsByCustomer(db, page.items.map((l) => l.customerId)),
  ]);
  const canUpdate = can(session, 'leads:update');
  const canOpp = can(session, 'opportunities:create');
  const cName = new Map(customers.map((c) => [c.id, c.fullName]));
  const owners = new Map(members.map((m) => [m.userId, m.fullName ?? m.email ?? 'Sin nombre']));
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: org.orgTimezone });

  const qs: Record<string, string> = {};
  for (const k of ['estado', 'fuente', 'resultado', 'responsable', 'desde', 'hasta', 'q'] as const) if (sp[k]) qs[k] = sp[k]!;
  const back = `/leads${Object.keys(qs).length ? `?${new URLSearchParams(qs)}` : ''}`;
  const hasFilters = Object.keys(qs).length > 0;

  return (
    <>
      <header className="page-head">
        <h1>Leads</h1>
        <p className="muted">Cada lead es una señal de entrada (formulario, campaña, archivo, o creado a mano). Antes de crear nada se busca si esa persona ya es cliente.</p>
      </header>

      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <div className="flt-bar">
        <SearchInput basePath="/leads" initial={sp.q ?? ''} placeholder="Buscar por nombre, teléfono, correo o campaña" />
        <FilterSelect basePath="/leads" param="estado" label="Estado" value={sp.estado ?? ''} options={LEAD_STATUSES.map((s) => ({ value: s, label: LEAD_STATUS_LABEL[s]! }))} />
        <FilterSelect basePath="/leads" param="fuente" label="Fuente" value={sp.fuente ?? ''} options={sources.map((s) => ({ value: s, label: s }))} />
        <FilterSelect basePath="/leads" param="resultado" label="Resultado" value={sp.resultado ?? ''} options={Object.entries(LEAD_RESOLUTION_LABEL).map(([v, l]) => ({ value: v, label: l }))} />
        <FilterSelect basePath="/leads" param="responsable" label="Responsable" value={sp.responsable ?? ''} options={[{ value: 'sin_asignar', label: 'Sin asignar' }, ...members.filter((m) => m.status === 'active').map((m) => ({ value: m.userId, label: m.fullName ?? m.email ?? 'Sin nombre' }))]} />
        <DateFilter basePath="/leads" param="desde" label="Desde" value={sp.desde ?? ''} />
        <DateFilter basePath="/leads" param="hasta" label="Hasta" value={sp.hasta ?? ''} />
        {can(session, 'leads:create') ? (
          <div className="inline-form" style={{ marginLeft: 'auto' }}>
            <NewLeadModal trigger={<button type="button" className="btn btn-primary">+ Nuevo lead</button>} sources={sources} />
            <Link className="btn btn-secondary" href="/leads/import">Importar CSV</Link>
          </div>
        ) : null}
      </div>
      {hasFilters ? <p className="hint"><Link href="/leads">Quitar filtros</Link></p> : null}

      <section className="panel" aria-labelledby="leads-title">
        <div className="panel-head"><h2 id="leads-title">{hasFilters ? 'Resultados' : 'Recientes'} ({page.items.length}{page.nextCursor ? '+' : ''})</h2></div>
        {page.items.length === 0 ? (
          <div className="empty-state">
            <strong>{hasFilters ? 'Nada coincide con estos filtros.' : 'Aún no hay leads.'}</strong>
            <p>{hasFilters ? 'Prueba con otros filtros.' : <>Crea uno con «+ Nuevo lead», impórtalos con un archivo CSV, o conecta tu sitio web con la API en <Link href="/settings/integrations">Integraciones</Link>.</>}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Recibido</th><th scope="col">Cliente</th><th scope="col">Fuente</th>
                  <th scope="col">Estado</th><th scope="col">Resultado</th><th scope="col">Responsable</th><th scope="col"><span className="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((l) => (
                  <tr key={l.id}>
                    <td className="small">{fmt.format(new Date(l.receivedAt))}</td>
                    <td>
                      {cName.has(l.customerId) ? (
                        <>
                          <Link href={`/customers/${l.customerId}`}><strong>{cName.get(l.customerId)}</strong></Link>
                          <div className="tag-row" style={{ marginTop: 4 }}>{(tagsMap.get(l.customerId) ?? []).slice(0, 3).map((t) => <Tag key={t.id} tag={t} />)}</div>
                        </>
                      ) : <span className="muted">No disponible</span>}
                    </td>
                    <td className="small">{l.source}{l.campaign ? <span className="muted"> · {l.campaign}</span> : null}</td>
                    <td><span className={`badge ${LEAD_STATUS_BADGE[l.status] ?? ''}`}>{LEAD_STATUS_LABEL[l.status] ?? l.status}</span></td>
                    <td><span className={`badge ${l.resolution === 'review' || l.resolution === 'conflict' ? 'badge-warn' : 'badge-neutral'}`}>{LEAD_RESOLUTION_LABEL[l.resolution] ?? l.resolution}</span></td>
                    <td className="small">{l.ownerId ? (owners.get(l.ownerId) ?? '—') : <span className="muted">Sin asignar</span>}</td>
                    <td className="cell-actions">
                      <div className="inline-form" style={{ justifyContent: 'flex-end' }}>
                        {canUpdate && nextLeadStatuses(l.status).length > 0 ? (
                          <details className="task-complete">
                            <summary className="btn btn-secondary btn-sm">Estado</summary>
                            <form action={changeLeadStatusAction} className="stack task-complete-form" style={{ right: 0, left: 'auto', minWidth: 200 }}>
                              <input type="hidden" name="leadId" value={l.id} /><input type="hidden" name="returnTo" value={back} />
                              <label className="sr-only" htmlFor={`ls-${l.id}`}>Nuevo estado</label>
                              <select id={`ls-${l.id}`} name="to" className="select select-sm" defaultValue={nextLeadStatuses(l.status)[0]}>
                                {nextLeadStatuses(l.status).map((st) => <option key={st} value={st}>{LEAD_STATUS_LABEL[st]}</option>)}
                              </select>
                              <label className="sr-only" htmlFor={`lr-${l.id}`}>Motivo</label>
                              <input id={`lr-${l.id}`} name="reason" className="input" maxLength={500} placeholder="Motivo (si lo descartas)" />
                              <button className="btn btn-secondary btn-sm" type="submit">Cambiar</button>
                            </form>
                          </details>
                        ) : null}
                        {canConvert(l.status) && canUpdate && canOpp ? (
                          <form action={convertLeadAction}>
                            <input type="hidden" name="leadId" value={l.id} /><input type="hidden" name="returnTo" value={back} />
                            <button className="btn btn-primary btn-sm" type="submit">Convertir</button>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {page.nextCursor ? <p><Link className="btn btn-secondary" href={`/leads?${new URLSearchParams({ ...qs, cursor: page.nextCursor })}`}>Ver más</Link></p> : null}
      </section>
    </>
  );
}
