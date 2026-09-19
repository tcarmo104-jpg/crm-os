import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listLeads } from '@/repositories/leads';
import { getCustomersByIds } from '@/repositories/customers';
import { listMembers } from '@/repositories/members';
import { readFlash } from '@/lib/flash';
import { canConvert, nextLeadStatuses, LEAD_STATUS_LABEL } from '@/lib/leads';
import { Notice } from '@/components/ui';
import { changeLeadStatusAction, convertLeadAction } from './lead-actions';

export const metadata: Metadata = { title: 'Leads' };

const resolutionLabel: Record<string, string> = { created: 'Cliente nuevo', matched: 'Ya era cliente', review: 'Posible duplicado', conflict: 'Conflicto' };

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();

  const page = can(session, 'leads:read')
    ? await listLeads(db, { orgId: org.orgId, cursor: sp.cursor })
    : { items: [], nextCursor: null };
  const [customers, members, flash] = await Promise.all([
    getCustomersByIds(db, [...new Set(page.items.map((l) => l.customerId))]),
    listMembers(db, org.orgId),
    readFlash(),
  ]);
  const canUpdate = can(session, 'leads:update');
  const canOpp = can(session, 'opportunities:create');
  const back = `/leads${sp.cursor ? `?cursor=${encodeURIComponent(sp.cursor)}` : ''}`;
  const cName = new Map(customers.map((c) => [c.id, c.fullName]));
  const owners = new Map(members.map((m) => [m.userId, m.fullName ?? m.email ?? 'Sin nombre']));
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: org.orgTimezone });

  return (
    <>
      <header className="page-head">
        <h1>Leads</h1>
        <p className="muted">
          Cada lead es una señal de entrada (formulario, campaña, archivo). Antes de crear nada se busca si esa persona ya es cliente.
        </p>
      </header>

      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <section className="panel" aria-labelledby="leads-title">
        <div className="panel-head">
          <h2 id="leads-title">Recientes</h2>
          {can(session, 'leads:create') ? <Link className="btn btn-secondary" href="/leads/import">Importar CSV</Link> : null}
        </div>
        {page.items.length === 0 ? (
          <div className="empty">
            <p><strong>Aún no hay leads.</strong></p>
            <p className="muted">
              Importa un archivo CSV o conecta tu sitio web con la API en <Link href="/settings/integrations">Integraciones</Link>.
            </p>
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
                    <td>{fmt.format(new Date(l.receivedAt))}</td>
                    <td>
                      {cName.has(l.customerId)
                        ? <Link href={`/customers/${l.customerId}`}>{cName.get(l.customerId)}</Link>
                        : <span className="muted">No disponible</span>}
                    </td>
                    <td>{l.source}{l.campaign ? <span className="muted"> · {l.campaign}</span> : null}</td>
                    <td><span className="badge">{LEAD_STATUS_LABEL[l.status] ?? l.status}</span></td>
                    <td><span className={`badge ${l.resolution === 'review' || l.resolution === 'conflict' ? 'badge-warn' : ''}`}>{resolutionLabel[l.resolution] ?? l.resolution}</span></td>
                    <td>{l.ownerId ? (owners.get(l.ownerId) ?? '—') : <span className="muted">Sin asignar</span>}</td>
                    <td>
                      {canUpdate && nextLeadStatuses(l.status).length > 0 ? (
                        <details>
                          <summary>Estado</summary>
                          <form action={changeLeadStatusAction} className="stack">
                            <input type="hidden" name="leadId" value={l.id} /><input type="hidden" name="returnTo" value={back} />
                            <label className="sr-only" htmlFor={`ls-${l.id}`}>Nuevo estado</label>
                            <select id={`ls-${l.id}`} name="to" className="select select-sm" defaultValue={nextLeadStatuses(l.status)[0]}>
                              {nextLeadStatuses(l.status).map((st) => <option key={st} value={st}>{LEAD_STATUS_LABEL[st]}</option>)}
                            </select>
                            <label className="sr-only" htmlFor={`lr-${l.id}`}>Motivo</label>
                            <input id={`lr-${l.id}`} name="reason" className="input" maxLength={500} placeholder="Motivo (obligatorio si lo descartas)" />
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {page.nextCursor ? <p><Link className="btn btn-secondary" href={`/leads?cursor=${encodeURIComponent(page.nextCursor)}`}>Ver más</Link></p> : null}
      </section>
    </>
  );
}
