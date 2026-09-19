import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { describeEvent } from '@/lib/timeline';
import { getCustomer, listCompanies, listIdentifiers, timeline } from '@/repositories/customers';
import { listLeads } from '@/repositories/leads';
import { listMembers } from '@/repositories/members';
import { listFieldDefinitions } from '@/repositories/custom-fields';
import { listOpportunities } from '@/repositories/opportunities';
import { listTasks } from '@/repositories/tasks';
import { listPipelines } from '@/repositories/pipelines';
import { formatMoney } from '@/lib/money';
import { TASK_TYPE_LABEL, CONTACT_TASK_TYPES } from '@/lib/tasks';
import { LogActivityForm, NewTaskForm } from '@/components/sales-forms';
import { completeTaskAction } from '../../tasks/actions';
import { listSales, listCases } from '@/repositories/sales';
import { NewCaseForm } from '@/components/commerce-forms';
import { listConversations } from '@/repositories/inbox';
import { SALE_STATUS, CASE_STATUS, CASE_KIND } from '@/lib/commerce-labels';
import { uuidSchema } from '@/services/schemas';
import { ConfirmButton, Notice } from '@/components/ui';
import { AddIdentifierForm, DncForm, EditProfileForm, OwnerForm } from '@/components/customer-forms';
import { removeIdentifierAction } from '../actions';

export const metadata: Metadata = { title: 'Cliente' };

const idLabel: Record<string, string> = { phone: 'Teléfono', email: 'Correo', instagram: 'Instagram', facebook: 'Facebook', external: 'ID externo' };
const resolutionLabel: Record<string, string> = { created: 'Cliente nuevo', matched: 'Ya era cliente', review: 'Posible duplicado', conflict: 'Conflicto de identidad' };

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();

  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();

  const customer = await getCustomer(db, id);
  if (!customer) notFound();

  const [identifiers, events, leads, members, defs, companies, flash, opps, tasks, pipelines, salesPage, cases, convPage] = await Promise.all([
    listIdentifiers(db, [id]),
    timeline(db, id, 50),
    listLeads(db, { orgId: org.orgId, customerId: id, limit: 20 }),
    listMembers(db, org.orgId),
    listFieldDefinitions(db, org.orgId, 'customer'),
    customer.type === 'person' ? listCompanies(db, org.orgId) : Promise.resolve([]),
    readFlash(),
    can(session, 'opportunities:read') ? listOpportunities(db, { orgId: org.orgId, customerId: id, limit: 50 }) : Promise.resolve([]),
    can(session, 'tasks:read') ? listTasks(db, { orgId: org.orgId, customerId: id, status: 'open', limit: 50 }) : Promise.resolve([]),
    listPipelines(db, org.orgId, true),
    can(session, 'sales:read') ? listSales(db, { orgId: org.orgId, customerId: id, limit: 50 }) : Promise.resolve({ items: [], nextCursor: null }),
    can(session, 'cases:read') ? listCases(db, { orgId: org.orgId, customerId: id, limit: 50 }) : Promise.resolve([]),
    can(session, 'conversations:read') ? listConversations(db, { orgId: org.orgId, filter: 'open', customerId: id, limit: 10 }) : Promise.resolve({ items: [], nextCursor: null }),
  ]);
  const stageName = new Map(pipelines.flatMap((p) => p.stages.map((s) => [s.id, s.name] as const)));
  const back = `/customers/${id}`;

  const canUpdate = can(session, 'customers:update');
  const orgScope = session.permissions['customers:update'] === 'org';
  const active = members.filter((m) => m.status === 'active');
  const nameOf = (uid: string | null | undefined) => {
    const m = members.find((x) => x.userId === uid);
    return m?.fullName ?? m?.email ?? 'Alguien';
  };
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: org.orgTimezone });
  const company = companies.find((c) => c.id === customer.companyId);

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href="/customers">← Clientes</Link></p>
        <h1>
          {customer.fullName}{' '}
          {customer.type === 'company' ? <span className="badge">Empresa</span> : null}{' '}
          {customer.doNotContact ? <span className="badge badge-danger">No contactar</span> : null}
        </h1>
        <p className="muted">
          Cliente desde {fmt.format(new Date(customer.firstContactAt))} ·{' '}
          {customer.ownerId ? `Responsable: ${nameOf(customer.ownerId)}` : 'Sin responsable asignado'}
        </p>
      </header>

      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <div className="detail-grid">
        <div className="detail-col">
          <section className="panel" aria-labelledby="data-title">
            <div className="panel-head"><h2 id="data-title">Datos</h2></div>
            {canUpdate ? (
              <EditProfileForm customer={customer} companies={companies} defs={defs} />
            ) : (
              <dl className="kv">
                <dt>Ciudad</dt><dd>{customer.city ?? '—'}</dd>
                <dt>País</dt><dd>{customer.country ?? '—'}</dd>
                <dt>Dirección</dt><dd>{customer.address ?? '—'}</dd>
                {company ? (<><dt>Empresa</dt><dd>{company.fullName}</dd></>) : null}
              </dl>
            )}
          </section>

          <section className="panel" aria-labelledby="contact-title">
            <div className="panel-head"><h2 id="contact-title">Contacto</h2></div>
            {identifiers.length === 0 ? <p className="muted">Sin datos de contacto.</p> : (
              <ul className="id-list">
                {identifiers.map((i) => (
                  <li key={i.id}>
                    <span><span className="muted">{idLabel[i.type] ?? i.type}:</span> {i.value}</span>
                    {canUpdate ? (
                      <form action={removeIdentifierAction}>
                        <input type="hidden" name="customerId" value={customer.id} />
                        <input type="hidden" name="identifierId" value={i.id} />
                        <ConfirmButton message="¿Eliminar este dato de contacto?" className="btn btn-ghost btn-sm">Quitar</ConfirmButton>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {canUpdate ? <AddIdentifierForm customerId={customer.id} /> : null}
          </section>

          {orgScope ? (
            <section className="panel" aria-labelledby="owner-title">
              <div className="panel-head"><h2 id="owner-title">Responsable</h2></div>
              <OwnerForm
                customerId={customer.id} ownerId={customer.ownerId}
                people={active.map((m) => ({ id: m.userId, name: m.fullName ?? m.email ?? 'Sin nombre' }))}
              />
              <p className="hint">Los leads abiertos de este cliente pasan al nuevo responsable.</p>
            </section>
          ) : null}

          {canUpdate ? (
            <section className="panel" aria-labelledby="dnc-title">
              <div className="panel-head"><h2 id="dnc-title">Preferencias de contacto</h2></div>
              <DncForm customerId={customer.id} active={customer.doNotContact} reason={customer.dncReason} canClear={orgScope} />
            </section>
          ) : null}
        </div>

        <div className="detail-col">
          <section className="panel" aria-labelledby="opps-title">
            <div className="panel-head">
              <h2 id="opps-title">Oportunidades ({opps.length})</h2>
              {can(session, 'opportunities:create') ? <Link className="btn btn-secondary btn-sm" href={`/opportunities/new?customer=${customer.id}`}>Nueva</Link> : null}
            </div>
            {opps.length === 0 ? <p className="muted">Este cliente no tiene oportunidades.</p> : (
              <ul className="id-list">
                {opps.map((o) => (
                  <li key={o.id}>
                    <span><Link href={`/opportunities/${o.id}`}><strong>{o.title}</strong></Link>{' '}
                      <span className={`badge ${o.status === 'won' ? 'badge-ok' : o.status === 'lost' ? 'badge-danger' : ''}`}>{o.status === 'open' ? (stageName.get(o.stageId) ?? 'Abierta') : o.status === 'won' ? 'Ganada' : 'Perdida'}</span></span>
                    <span>{formatMoney(o.amount, o.currency, org.orgLocale)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="conv-title">
            <div className="panel-head"><h2 id="conv-title">Conversaciones ({convPage.items.length})</h2></div>
            {convPage.items.length === 0 ? <p className="muted">Este cliente no ha escrito por WhatsApp.</p> : (
              <ul className="id-list">
                {convPage.items.map((cv) => (
                  <li key={cv.id}><span><Link href={`/inbox/${cv.id}`}><strong>WhatsApp · +{cv.threadKey}</strong></Link>{cv.needsReply ? <> <span className="badge badge-warn">Sin responder</span></> : null}<br /><span className="small muted">{cv.lastMessagePreview}</span></span>
                    <span className={`badge ${cv.status === 'open' ? 'badge-ok' : ''}`}>{cv.status === 'open' ? 'Abierta' : 'Cerrada'}</span></li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="sales-title">
            <div className="panel-head"><h2 id="sales-title">Ventas ({salesPage.items.length})</h2></div>
            {salesPage.items.length === 0 ? <p className="muted">Este cliente aún no tiene ventas.</p> : (
              <ul className="id-list">
                {salesPage.items.map((sv) => (
                  <li key={sv.id}>
                    <span><Link href={`/sales/${sv.id}`}><strong>{sv.number}</strong></Link>{' '}<span className={`badge ${SALE_STATUS[sv.status]?.[1] ?? ''}`}>{SALE_STATUS[sv.status]?.[0] ?? sv.status}</span></span>
                    <span>{formatMoney(sv.total, sv.currency, org.orgLocale)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="cases-title">
            <div className="panel-head"><h2 id="cases-title">Casos de postventa ({cases.length})</h2></div>
            {cases.length === 0 ? <p className="muted">Sin casos.</p> : (
              <ul className="id-list">
                {cases.map((cs) => (
                  <li key={cs.id}><span><strong>{cs.number}</strong> · {cs.title} <span className="small muted">({CASE_KIND[cs.kind] ?? cs.kind})</span></span>
                    <span className={`badge ${CASE_STATUS[cs.status]?.[1] ?? ''}`}>{CASE_STATUS[cs.status]?.[0] ?? cs.status}</span></li>
                ))}
              </ul>
            )}
            {can(session, 'cases:create') ? (
              <details><summary>Abrir un caso</summary><NewCaseForm customerId={customer.id} sales={salesPage.items.filter((sv) => sv.status !== 'cancelled').map((sv) => ({ id: sv.id, number: sv.number }))} /></details>
            ) : null}
          </section>

          <section className="panel" aria-labelledby="tasks-title">
            <div className="panel-head"><h2 id="tasks-title">Tareas pendientes ({tasks.length})</h2></div>
            {tasks.length === 0 ? <p className="muted">No hay tareas pendientes para este cliente.</p> : tasks.map((t) => (
              <div className="task-row" key={t.id}>
                <div className="main">
                  <strong>{t.title}</strong>
                  <span className="small muted">{TASK_TYPE_LABEL[t.type] ?? t.type}{t.dueAt ? ` · vence ${fmt.format(new Date(t.dueAt))}` : ''}{t.assigneeId ? ` · ${nameOf(t.assigneeId)}` : ''}
                    {customer.doNotContact && CONTACT_TASK_TYPES.includes(t.type) ? ' · ⚠ no contactar' : ''}</span>
                </div>
                <form action={completeTaskAction} className="acts">
                  <input type="hidden" name="taskId" value={t.id} /><input type="hidden" name="returnTo" value={back} />
                  <button className="btn btn-secondary btn-sm" type="submit">Completar</button>
                </form>
              </div>
            ))}
            {can(session, 'tasks:create') ? (
              <details><summary>Nueva tarea</summary><NewTaskForm customerId={customer.id} returnTo={back} dncWarning={customer.doNotContact} /></details>
            ) : null}
          </section>

          {canUpdate ? (
            <section className="panel" aria-labelledby="act-title">
              <div className="panel-head"><h2 id="act-title">Registrar actividad</h2></div>
              <LogActivityForm customerId={customer.id} />
            </section>
          ) : null}

          <section className="panel" aria-labelledby="leads-title">
            <div className="panel-head"><h2 id="leads-title">Leads ({leads.items.length}{leads.nextCursor ? '+' : ''})</h2></div>
            {leads.items.length === 0 ? <p className="muted">Este cliente no ha llegado por ningún lead.</p> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th scope="col">Recibido</th><th scope="col">Fuente</th><th scope="col">Interés</th><th scope="col">Resultado</th></tr></thead>
                  <tbody>
                    {leads.items.map((l) => (
                      <tr key={l.id}>
                        <td>{fmt.format(new Date(l.receivedAt))}</td>
                        <td>{l.source}{l.campaign ? <span className="muted"> · {l.campaign}</span> : null}</td>
                        <td>{l.productInterest ?? <span className="muted">—</span>}</td>
                        <td><span className="badge">{resolutionLabel[l.resolution] ?? l.resolution}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel" aria-labelledby="activity-title">
            <div className="panel-head"><h2 id="activity-title">Actividad</h2></div>
            {events.length === 0 ? <p className="muted">Todavía no hay actividad.</p> : (
              <ol className="timeline">
                {events.map((e) => {
                  const d = describeEvent(e, nameOf);
                  return (
                    <li key={e.id}>
                      <strong>{d.title}</strong>
                      {d.detail ? <span className="small">{d.detail}</span> : null}
                      <span className="when">{fmt.format(new Date(e.occurredAt))}{e.actorId ? ` · ${nameOf(e.actorId)}` : ''}</span>
                    </li>
                  );
                })}
              </ol>
            )}
            <p className="hint">Las conversaciones de WhatsApp, Instagram y correo aparecerán aquí cuando se habilite el Inbox (Fase 5).</p>
          </section>
        </div>
      </div>
    </>
  );
}
