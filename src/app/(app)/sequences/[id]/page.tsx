import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { getSequence, listEnrollmentsBySequence } from '@/repositories/sequences';
import { getCustomersByIds } from '@/repositories/customers';
import { ENROLLMENT_STATUS_BADGE, ENROLLMENT_STATUS_LABEL, offsetLabel, SEQUENCE_STEP_TYPE_ICON, SEQUENCE_STEP_TYPE_LABEL } from '@/lib/sequences';
import { PRIORITY_LABEL } from '@/lib/tasks';
import { ConfirmButton, Notice } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { uuidSchema } from '@/services/schemas';
import { archiveSequenceAction, cancelEnrollmentAction, pauseEnrollmentAction, resumeEnrollmentAction } from '../actions';

export const metadata: Metadata = { title: 'Secuencia' };

export default async function SequenceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  if (!can(session, 'sequences:read')) notFound();

  const seq = await getSequence(db, id);
  if (!seq) notFound();
  const [enrollments, flash] = await Promise.all([listEnrollmentsBySequence(db, id), readFlash()]);
  const customers = await getCustomersByIds(db, [...new Set(enrollments.map((e) => e.customerId))]);
  const cName = new Map(customers.map((c) => [c.id, c.fullName]));
  const canManage = can(session, 'sequences:manage');
  const back = `/sequences/${id}`;
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeZone: org.orgTimezone });
  const active = enrollments.filter((e) => e.status === 'active' || e.status === 'paused');

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href="/sequences">← Secuencias</Link></p>
        <h1>{seq.name} {!seq.isActive ? <span className="badge badge-neutral">Archivada</span> : null}</h1>
        {seq.description ? <p className="muted">{seq.description}</p> : null}
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      {canManage ? (
        <form action={archiveSequenceAction}>
          <input type="hidden" name="sequenceId" value={seq.id} /><input type="hidden" name="returnTo" value={back} />
          <input type="hidden" name="active" value={seq.isActive ? '0' : '1'} />
          <ConfirmButton
            message={seq.isActive ? '¿Archivar esta secuencia? Ya no se podrá inscribir a nadie más (las inscripciones activas siguen igual).' : '¿Reactivar esta secuencia?'}
            className={seq.isActive ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'}
          >
            {seq.isActive ? 'Archivar' : 'Reactivar'}
          </ConfirmButton>
        </form>
      ) : null}

      <section className="panel" aria-labelledby="steps-title">
        <div className="panel-head"><h2 id="steps-title">Pasos ({seq.steps.length})</h2></div>
        <ol className="step-list">
          {seq.steps.map((s) => (
            <li key={s.id} className="step-row">
              <span className="step-num">{s.position}</span>
              <div className="step-body">
                <p className="step-title"><Icon name={SEQUENCE_STEP_TYPE_ICON[s.type] ?? 'box'} size={14} /> {s.title}</p>
                <p className="step-meta">{SEQUENCE_STEP_TYPE_LABEL[s.type] ?? s.type} · {offsetLabel(s.offsetDays)} · Prioridad {PRIORITY_LABEL[s.priority] ?? s.priority}</p>
                {s.description ? <p className="step-meta">{s.description}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel" aria-labelledby="enr-title">
        <div className="panel-head"><h2 id="enr-title">Inscripciones ({enrollments.length})</h2></div>
        {enrollments.length === 0 ? (
          <p className="muted">Todavía no has inscrito a ningún cliente. Puedes hacerlo desde la ficha de un cliente.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Cliente</th><th scope="col">Paso</th><th scope="col">Estado</th><th scope="col">Desde</th><th scope="col"><span className="sr-only">Acciones</span></th></tr></thead>
              <tbody>
                {enrollments.map((e) => (
                  <tr key={e.id}>
                    <td><Link href={`/customers/${e.customerId}`}>{cName.get(e.customerId) ?? 'Cliente'}</Link></td>
                    <td className="small">Paso {e.currentStep} de {seq.steps.length}</td>
                    <td><span className={`badge ${ENROLLMENT_STATUS_BADGE[e.status]}`}>{ENROLLMENT_STATUS_LABEL[e.status]}</span></td>
                    <td className="small">{fmt.format(new Date(e.enrolledAt))}</td>
                    <td className="cell-actions">
                      {active.includes(e) ? (
                        <div className="inline-form" style={{ justifyContent: 'flex-end' }}>
                          {e.status === 'active' ? (
                            <form action={pauseEnrollmentAction}><input type="hidden" name="enrollmentId" value={e.id} /><input type="hidden" name="returnTo" value={back} /><button className="btn btn-secondary btn-sm" type="submit">Pausar</button></form>
                          ) : (
                            <form action={resumeEnrollmentAction}><input type="hidden" name="enrollmentId" value={e.id} /><input type="hidden" name="returnTo" value={back} /><button className="btn btn-secondary btn-sm" type="submit">Reanudar</button></form>
                          )}
                          <form action={cancelEnrollmentAction}>
                            <input type="hidden" name="enrollmentId" value={e.id} /><input type="hidden" name="returnTo" value={back} />
                            <ConfirmButton message="¿Cancelar el seguimiento de este cliente?" className="btn btn-ghost btn-sm">Cancelar</ConfirmButton>
                          </form>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
