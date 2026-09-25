'use client';

import Link from 'next/link';
import { ConfirmButton } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { PRIORITY_LABEL, STATUS_BADGE, STATUS_LABEL, TASK_TYPE_ICON, TASK_TYPE_LABEL, isOverdue, type TaskStatus } from '@/lib/tasks';
import type { TaskRow } from '@/lib/types';
import { EditTaskModal, type Opt } from './TaskModals';
import { cancelTaskAction, completeTaskAction, reopenTaskAction, startTaskAction } from '@/app/(app)/tasks/actions';

/** Una tarjeta de tarea: qué es, con quién, quién responde, cuándo y en qué estado — todo de un vistazo. */
export function TaskCard({ task, customerName, opportunityTitle, assigneeName, showAssignee, locale, timeZone, people, returnTo, dense }: {
  task: TaskRow; customerName: string | null; opportunityTitle: string | null; assigneeName: string; showAssignee: boolean;
  locale: string; timeZone: string; people: Opt[]; returnTo: string; dense?: boolean;
}) {
  // El formateador se crea AQUÍ, del lado del cliente: un `Intl.DateTimeFormat` no se puede pasar como prop desde un Server Component.
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone });
  const overdue = isOverdue(task);
  const open = task.status === 'open' || task.status === 'in_progress';
  return (
    <div className={`task-card${overdue ? ' is-overdue' : ''}${dense ? ' is-dense' : ''}`}>
      <div className="task-card-top">
        <span className="task-type-chip"><Icon name={TASK_TYPE_ICON[task.type] ?? 'box'} size={13} />{TASK_TYPE_LABEL[task.type] ?? task.type}</span>
        {task.priority !== 'normal' ? <span className={`badge ${task.priority === 'high' ? 'badge-warn' : 'badge-neutral'}`}>{PRIORITY_LABEL[task.priority]}</span> : null}
        {overdue ? <span className="badge badge-danger">Vencida</span> : <span className={`badge ${STATUS_BADGE[task.status as TaskStatus]}`}>{STATUS_LABEL[task.status as TaskStatus]}</span>}
      </div>
      <p className="task-card-title">{task.title}</p>
      {task.description ? <p className="task-card-desc">{task.description}</p> : null}
      <p className="task-card-meta">
        {task.dueAt ? <span className={overdue ? 'is-danger' : undefined}>{fmt.format(new Date(task.dueAt))}</span> : <span className="muted">Sin fecha</span>}
        {customerName ? <> · <Link href={`/customers/${task.customerId}`}>{customerName}</Link></> : null}
        {opportunityTitle ? <> · <Link href={`/opportunities/${task.opportunityId}`}>{opportunityTitle}</Link></> : null}
      </p>
      {showAssignee ? <p className="task-card-meta muted">{assigneeName}</p> : null}
      {task.outcome ? <p className="task-card-outcome">Resultado: {task.outcome}</p> : null}
      <div className="task-card-acts">
        {task.status === 'open' ? (
          <form action={startTaskAction}><input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="returnTo" value={returnTo} /><button className="btn btn-secondary btn-sm" type="submit">Empezar</button></form>
        ) : null}
        {open ? (
          <details className="task-complete">
            <summary className="btn btn-primary btn-sm">Completar</summary>
            <form action={completeTaskAction} className="task-complete-form">
              <input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="returnTo" value={returnTo} />
              <label className="sr-only" htmlFor={`o-${task.id}`}>Resultado</label>
              <input id={`o-${task.id}`} name="outcome" className="input" maxLength={500} placeholder="Resultado (opcional)" />
              <button className="btn btn-primary btn-sm" type="submit">Guardar</button>
            </form>
          </details>
        ) : null}
        {open ? <EditTaskModal task={task} people={people} returnTo={returnTo} /> : null}
        {open ? (
          <form action={cancelTaskAction}>
            <input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="returnTo" value={returnTo} />
            <ConfirmButton message="¿Cancelar esta tarea?" className="btn btn-ghost btn-sm">Cancelar</ConfirmButton>
          </form>
        ) : (
          <form action={reopenTaskAction}><input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="returnTo" value={returnTo} /><button className="btn btn-ghost btn-sm" type="submit">Reabrir</button></form>
        )}
      </div>
    </div>
  );
}
