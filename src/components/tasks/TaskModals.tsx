'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useActionState } from 'react';
import { initialActionState } from '@/lib/action-state';
import { TASK_TYPE_LABEL, TASK_TYPES, PRIORITY_LABEL } from '@/lib/tasks';
import type { TaskRow } from '@/lib/types';
import { Feedback, Field } from '@/components/forms';
import { CloseOnSuccess, Modal, SubmitButton } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { createTaskAction, editTaskAction } from '@/app/(app)/tasks/actions';

export interface Opt { id: string; name: string }
export interface OppOpt { id: string; title: string; customerId: string }

function TypeAndPriority({ type, priority }: { type?: string; priority?: string }) {
  return (
    <div className="grid-2">
      <div className="field">
        <label className="label" htmlFor="tm-type">Tipo</label>
        <select id="tm-type" name="type" className="select" defaultValue={type ?? 'follow_up'}>
          {TASK_TYPES.map((t) => <option key={t} value={t}>{TASK_TYPE_LABEL[t]}</option>)}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="tm-priority">Prioridad</label>
        <select id="tm-priority" name="priority" className="select" defaultValue={priority ?? 'normal'}>
          {Object.entries(PRIORITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
    </div>
  );
}

/** «+ Nueva tarea»: crear desde cualquier parte (elige cliente y, si aplica, oportunidad). Compacto: solo lo necesario. */
export function NewTaskModal({ trigger, customers, opportunities, people, returnTo, defaultCustomerId }: {
  trigger: ReactNode; customers: Opt[]; opportunities: OppOpt[]; people: Opt[]; returnTo: string; defaultCustomerId?: string;
}) {
  const [state, formAction] = useActionState(createTaskAction, initialActionState);
  const [customerId, setCustomerId] = useState(defaultCustomerId ?? '');
  const oppOptions = useMemo(() => opportunities.filter((o) => !customerId || o.customerId === customerId), [opportunities, customerId]);
  return (
    <Modal title="Nueva tarea" trigger={trigger}>
      <form action={formAction} className="stack" noValidate>
        <Feedback state={state} />
        <CloseOnSuccess ok={state.ok} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <Field label="¿Qué hay que hacer?" name="title" maxLength={160} placeholder="Llamar para confirmar la visita" />
        <TypeAndPriority />
        <div className="grid-2">
          <Field label="Vence" name="due" type="datetime-local" required={false} />
          {people.length > 0 ? (
            <div className="field">
              <label className="label" htmlFor="tm-assignee">Responsable</label>
              <select id="tm-assignee" name="assigneeId" className="select" defaultValue="">
                <option value="">Yo</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          ) : null}
        </div>
        <div className="grid-2">
          <div className="field">
            <label className="label" htmlFor="tm-customer">Cliente relacionado</label>
            <select id="tm-customer" name="customerId" className="select" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Sin cliente</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="tm-opp">Oportunidad relacionada</label>
            <select id="tm-opp" name="opportunityId" className="select" defaultValue="" disabled={oppOptions.length === 0}>
              <option value="">{oppOptions.length === 0 ? 'Ninguna' : 'Sin oportunidad'}</option>
              {oppOptions.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="tm-desc">Descripción</label>
          <textarea id="tm-desc" name="description" className="input" rows={3} maxLength={2000} placeholder="Detalles opcionales" />
        </div>
        <SubmitButton pendingLabel="Creando…">Crear tarea</SubmitButton>
      </form>
    </Modal>
  );
}

/** Editar: solo lo que sigue teniendo sentido cambiar (el cliente y la oportunidad no se mueven de una tarea ya creada). */
export function EditTaskModal({ task, people, returnTo }: { task: TaskRow; people: Opt[]; returnTo: string }) {
  const [state, formAction] = useActionState(editTaskAction, initialActionState);
  const due = task.dueAt ? task.dueAt.slice(0, 16) : '';
  return (
    <Modal title="Editar tarea" trigger={<button type="button" className="btn btn-ghost btn-sm"><Icon name="gear" size={14} /> Editar</button>}>
      <form action={formAction} className="stack" noValidate>
        <Feedback state={state} />
        <CloseOnSuccess ok={state.ok} />
        <input type="hidden" name="taskId" value={task.id} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <Field label="¿Qué hay que hacer?" name="title" maxLength={160} defaultValue={task.title} />
        <TypeAndPriority type={task.type} priority={task.priority} />
        <div className="grid-2">
          <Field label="Vence" name="due" type="datetime-local" required={false} defaultValue={due} />
          {people.length > 0 ? (
            <div className="field">
              <label className="label" htmlFor="tm-e-assignee">Responsable</label>
              <select id="tm-e-assignee" name="assigneeId" className="select" defaultValue={task.assigneeId ?? ''}>
                <option value={task.assigneeId ?? ''}>Sin cambiar</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          ) : null}
        </div>
        <div className="field">
          <label className="label" htmlFor="tm-e-desc">Descripción</label>
          <textarea id="tm-e-desc" name="description" className="input" rows={3} maxLength={2000} defaultValue={task.description ?? ''} />
        </div>
        <SubmitButton pendingLabel="Guardando…">Guardar cambios</SubmitButton>
      </form>
    </Modal>
  );
}
