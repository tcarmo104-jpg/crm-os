import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { formatMoney } from '@/lib/money';
import { orderedStages } from '@/lib/pipeline';
import { TASK_TYPE_LABEL } from '@/lib/tasks';
import { getCustomer } from '@/repositories/customers';
import { getOpportunity, listTransitions } from '@/repositories/opportunities';
import { listPipelines } from '@/repositories/pipelines';
import { listTasks } from '@/repositories/tasks';
import { listActivities } from '@/repositories/activities';
import { listMembers } from '@/repositories/members';
import { listFieldDefinitions } from '@/repositories/custom-fields';
import { uuidSchema } from '@/services/schemas';
import { Notice } from '@/components/ui';
import { EditOpportunityForm, LogActivityForm, NewTaskForm } from '@/components/sales-forms';
import { moveOpportunityAction } from '../actions';
import { completeTaskAction } from '../../tasks/actions';

export const metadata: Metadata = { title: 'Oportunidad' };

const statusBadge = { open: ['Abierta', ''], won: ['Ganada', 'badge-ok'], lost: ['Perdida', 'badge-danger'] } as const;
const actLabel: Record<string, string> = { call: 'Llamada', whatsapp: 'WhatsApp', email: 'Correo', meeting: 'Reunión', note: 'Nota' };

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();

  const opp = await getOpportunity(db, id);
  if (!opp) notFound();

  const [customer, transitions, tasks, acts, members, defs, pipelines, flash] = await Promise.all([
    getCustomer(db, opp.customerId),
    listTransitions(db, 'opportunity', id),
    listTasks(db, { orgId: org.orgId, opportunityId: id, status: 'open' }),
    listActivities(db, { opportunityId: id, limit: 20 }),
    listMembers(db, org.orgId),
    listFieldDefinitions(db, org.orgId, 'opportunity'),
    listPipelines(db, org.orgId, true),
    readFlash(),
  ]);
  const pipeline = pipelines.find((p) => p.id === opp.pipelineId);
  const stages = pipeline ? orderedStages(pipeline.stages) : [];
  const stage = pipeline?.stages.find((s) => s.id === opp.stageId);
  const nameOf = (uid: string | null | undefined) => {
    const m = members.find((x) => x.userId === uid);
    return m?.fullName ?? m?.email ?? 'Alguien';
  };
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: org.orgTimezone });
  const managerScope = session.permissions['opportunities:update'] === 'org';
  const canUpdate = can(session, 'opportunities:update');
  const closedLocked = opp.status !== 'open' && !managerScope;
  const [label, cls] = statusBadge[opp.status];
  const back = `/opportunities/${id}`;
  const taskScope = session.permissions['tasks:create'];
  const myTeam = members.find((m) => m.userId === session.user.id)?.teamId ?? null;
  const people = members.filter((m) => m.status === 'active' && m.userId !== session.user.id
    && (taskScope === 'org' || (taskScope === 'team' && myTeam !== null && m.teamId === myTeam)))
    .map((m) => ({ id: m.userId, name: m.fullName ?? m.email ?? 'Sin nombre' }));

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href="/opportunities">← Oportunidades</Link></p>
        <h1>{opp.title} <span className={`badge ${cls}`}>{label}</span></h1>
        <p className="muted">
          {formatMoney(opp.amount, opp.currency, org.orgLocale)} · {pipeline?.name ?? 'Pipeline'} → <strong>{stage?.name ?? '—'}</strong>
          {stage && opp.status === 'open' ? ` (${stage.probability}%)` : ''} ·{' '}
          {customer ? <Link href={`/customers/${customer.id}`}>{customer.fullName}</Link> : 'Cliente no disponible'}
          {' '}· {opp.ownerId ? `Responsable: ${nameOf(opp.ownerId)}` : 'Sin responsable'}
        </p>
        {opp.status === 'lost' && opp.lostReason ? <p className="muted">Motivo de pérdida: {opp.lostReason}</p> : null}
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <div className="detail-grid">
        <div className="detail-col">
          {canUpdate && !closedLocked ? (
            <section className="panel" aria-labelledby="move-title">
              <div className="panel-head"><h2 id="move-title">{opp.status === 'open' ? 'Mover de etapa' : 'Reabrir'}</h2></div>
              <form action={moveOpportunityAction} className="stack">
                <input type="hidden" name="opportunityId" value={opp.id} />
                <input type="hidden" name="returnTo" value={back} />
                <div className="field">
                  <label className="label" htmlFor="m-stage">Nueva etapa</label>
                  <select id="m-stage" name="stageId" className="select" defaultValue="">
                    <option value="" disabled>Elegir…</option>
                    {(['open', 'won', 'lost'] as const).map((k) => {
                      const list = stages.filter((s) => s.kind === k && s.id !== opp.stageId);
                      return list.length === 0 ? null : (
                        <optgroup key={k} label={k === 'open' ? 'Etapas abiertas' : k === 'won' ? 'Cerrar como ganada' : 'Cerrar como perdida'}>
                          {list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </optgroup>
                      );
                    })}
                  </select>
                </div>
                <div className="field">
                  <label className="label" htmlFor="m-reason">Motivo (obligatorio si la pierdes)</label>
                  <input id="m-reason" name="reason" className="input" maxLength={500} placeholder="Eligió a la competencia por precio" />
                </div>
                <div><button className="btn btn-primary" type="submit">Mover</button></div>
              </form>
            </section>
          ) : null}

          <section className="panel" aria-labelledby="edit-title">
            <div className="panel-head"><h2 id="edit-title">Datos</h2></div>
            <EditOpportunityForm opp={opp} defs={defs} readOnly={!canUpdate || closedLocked} />
          </section>

          <section className="panel" aria-labelledby="hist-title">
            <div className="panel-head"><h2 id="hist-title">Historial de etapas</h2></div>
            <ol className="timeline">
              {transitions.map((t) => (
                <li key={t.id}>
                  <strong>{t.fromState ? `${t.fromState} → ${t.toState}` : `Creada en «${t.toState}»`}</strong>
                  {t.reason ? <span className="small">{t.reason}</span> : null}
                  <span className="when">{fmt.format(new Date(t.occurredAt))}{t.actorId ? ` · ${nameOf(t.actorId)}` : ''}{t.source !== 'user' ? ` · ${t.source}` : ''}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <div className="detail-col">
          <section className="panel" aria-labelledby="tasks-title">
            <div className="panel-head"><h2 id="tasks-title">Tareas abiertas ({tasks.length})</h2></div>
            {tasks.length === 0 ? <p className="muted">No hay tareas pendientes.</p> : tasks.map((t) => (
              <div className="task-row" key={t.id}>
                <div className="main">
                  <strong>{t.title}</strong>
                  <span className="small muted">{TASK_TYPE_LABEL[t.type] ?? t.type}{t.dueAt ? ` · vence ${fmt.format(new Date(t.dueAt))}` : ''}{t.assigneeId ? ` · ${nameOf(t.assigneeId)}` : ''}</span>
                </div>
                <form action={completeTaskAction} className="acts">
                  <input type="hidden" name="taskId" value={t.id} />
                  <input type="hidden" name="returnTo" value={back} />
                  <button className="btn btn-secondary btn-sm" type="submit">Completar</button>
                </form>
              </div>
            ))}
            {can(session, 'tasks:create') ? (
              <details>
                <summary>Nueva tarea</summary>
                <NewTaskForm opportunityId={opp.id} returnTo={back} people={people} dncWarning={customer?.doNotContact} />
              </details>
            ) : null}
          </section>

          <section className="panel" aria-labelledby="acts-title">
            <div className="panel-head"><h2 id="acts-title">Actividad de esta oportunidad</h2></div>
            {acts.length === 0 ? <p className="muted">Aún no hay actividad registrada.</p> : (
              <ol className="timeline">
                {acts.map((a) => (
                  <li key={a.id}>
                    <strong>{actLabel[a.type] ?? a.type}{a.direction === 'inbound' ? ' (entrante)' : a.direction === 'outbound' ? ' (saliente)' : ''}</strong>
                    <span className="small">{a.summary}</span>
                    <span className="when">{fmt.format(new Date(a.occurredAt))}{a.createdBy ? ` · ${nameOf(a.createdBy)}` : ''}</span>
                  </li>
                ))}
              </ol>
            )}
            {customer && can(session, 'customers:update') ? (
              <details><summary>Registrar actividad</summary><LogActivityForm customerId={customer.id} opportunityId={opp.id} /></details>
            ) : null}
          </section>
        </div>
      </div>
    </>
  );
}
