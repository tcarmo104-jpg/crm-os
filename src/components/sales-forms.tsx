'use client';

import { useActionState } from 'react';
import { initialActionState } from '@/lib/action-state';
import type { FieldDefinition, OpportunityRow } from '@/lib/types';
import { Notice, SubmitButton } from './ui';
import { Feedback, Field } from './forms';
import { CustomFieldInputs } from './customer-forms';
import { createOpportunityAction, updateOpportunityAction } from '@/app/(app)/opportunities/actions';
import { createTaskAction, logActivityAction } from '@/app/(app)/tasks/actions';
import { addStageAction, createPipelineAction } from '@/app/(app)/settings/pipelines/actions';

export function NewOpportunityForm({ customerId, customerName, pipelines, defaultTitle }: {
  customerId: string; customerName: string; pipelines: { id: string; name: string; isDefault: boolean }[]; defaultTitle?: string;
}) {
  const [state, formAction] = useActionState(createOpportunityAction, initialActionState);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="customerId" value={customerId} />
      <p className="muted">Cliente: <strong>{customerName}</strong></p>
      <Field label="Título" name="title" maxLength={160} defaultValue={defaultTitle ?? ''} placeholder="Plan anual, Proyecto de remodelación…" />
      <div className="grid-3">
        <Field label="Monto estimado" name="amount" required={false} placeholder="1.500.000" inputMode="decimal" autoComplete="off" />
        <Field label="Cierre esperado" name="expectedClose" type="date" required={false} />
        {pipelines.length > 1 ? (
          <div className="field">
            <label className="label" htmlFor="f-pipelineId">Pipeline</label>
            <select id="f-pipelineId" name="pipelineId" className="select" defaultValue={pipelines.find((p) => p.isDefault)?.id}>
              {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        ) : null}
      </div>
      <Field label="Producto o servicio de interés" name="productInterest" required={false} maxLength={200} />
      <div><SubmitButton pendingLabel="Creando…">Crear oportunidad</SubmitButton></div>
    </form>
  );
}

export function EditOpportunityForm({ opp, defs, readOnly }: { opp: OpportunityRow; defs: FieldDefinition[]; readOnly: boolean }) {
  const [state, formAction] = useActionState(updateOpportunityAction, initialActionState);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="opportunityId" value={opp.id} />
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <Field label="Título" name="title" defaultValue={opp.title} maxLength={160} />
        <div className="grid-3">
          <Field label="Monto" name="amount" required={false} defaultValue={String(opp.amount)} inputMode="decimal" />
          <Field label="Cierre esperado" name="expectedClose" type="date" required={false} defaultValue={opp.expectedCloseDate ?? ''} />
          <Field label="Interés" name="productInterest" required={false} defaultValue={opp.productInterest ?? ''} maxLength={200} />
        </div>
        <CustomFieldInputs defs={defs} values={opp.customFields} />
      </fieldset>
      {readOnly ? <p className="hint">Una oportunidad cerrada solo la puede modificar un manager o administrador.</p> : <div><SubmitButton>Guardar cambios</SubmitButton></div>}
    </form>
  );
}

export function NewTaskForm({ customerId, opportunityId, returnTo, people, dncWarning }: {
  customerId?: string; opportunityId?: string; returnTo: string; people?: { id: string; name: string }[]; dncWarning?: boolean;
}) {
  const [state, formAction] = useActionState(createTaskAction, initialActionState);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      {dncWarning ? <Notice kind="error">Este cliente pidió no ser contactado: no programes llamadas, mensajes ni correos.</Notice> : null}
      {customerId ? <input type="hidden" name="customerId" value={customerId} /> : null}
      {opportunityId ? <input type="hidden" name="opportunityId" value={opportunityId} /> : null}
      <input type="hidden" name="returnTo" value={returnTo} />
      <Field id="task-title" label="¿Qué hay que hacer?" name="title" maxLength={160} placeholder="Llamar para confirmar la demo" />
      <div className="grid-3">
        <div className="field">
          <label className="label" htmlFor="t-type">Tipo</label>
          <select id="t-type" name="type" className="select" defaultValue="follow_up">
            <option value="follow_up">Seguimiento</option><option value="call">Llamada</option><option value="whatsapp">WhatsApp</option>
            <option value="email">Correo</option><option value="meeting">Reunión</option><option value="other">Otra</option>
          </select>
        </div>
        <Field id="task-due" label="Vence" name="due" type="datetime-local" required={false} />
        <div className="field">
          <label className="label" htmlFor="t-priority">Prioridad</label>
          <select id="t-priority" name="priority" className="select" defaultValue="normal">
            <option value="low">Baja</option><option value="normal">Normal</option><option value="high">Alta</option>
          </select>
        </div>
      </div>
      {people && people.length > 0 ? (
        <div className="field">
          <label className="label" htmlFor="t-assignee">Responsable</label>
          <select id="t-assignee" name="assigneeId" className="select" defaultValue="">
            <option value="">Yo</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      ) : null}
      <div><SubmitButton pendingLabel="Creando…">Crear tarea</SubmitButton></div>
    </form>
  );
}

export function LogActivityForm({ customerId, opportunityId }: { customerId: string; opportunityId?: string }) {
  const [state, formAction] = useActionState(logActivityAction, initialActionState);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="customerId" value={customerId} />
      {opportunityId ? <input type="hidden" name="opportunityId" value={opportunityId} /> : null}
      <div className="inline-form">
        <label className="sr-only" htmlFor="a-type">Tipo</label>
        <select id="a-type" name="type" className="select select-sm" defaultValue="call">
          <option value="call">Llamada</option><option value="whatsapp">WhatsApp</option><option value="email">Correo</option>
          <option value="meeting">Reunión</option><option value="note">Nota</option>
        </select>
        <label className="sr-only" htmlFor="a-dir">Dirección</label>
        <select id="a-dir" name="direction" className="select select-sm" defaultValue="outbound">
          <option value="outbound">Saliente</option><option value="inbound">Entrante</option>
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="a-summary">¿Qué pasó?</label>
        <textarea id="a-summary" name="summary" className="input" rows={3} maxLength={2000} required />
      </div>
      <p className="hint">Para notas y reuniones, la dirección no se usa. Las actividades no se editan: si te equivocas, agrega una nota.</p>
      <div><SubmitButton pendingLabel="Guardando…">Registrar</SubmitButton></div>
    </form>
  );
}

export function NewPipelineForm() {
  const [state, formAction] = useActionState(createPipelineAction, initialActionState);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <div className="inline-form">
        <Field label="Nombre del pipeline" name="name" maxLength={80} placeholder="Renovaciones" />
        <SubmitButton pendingLabel="Creando…">Crear pipeline</SubmitButton>
      </div>
      <p className="hint">Nace con las etapas habituales (Nuevo, Contactado, Propuesta, Negociación, Ganada, Perdida) que puedes ajustar.</p>
    </form>
  );
}

export function AddStageForm({ pipelineId }: { pipelineId: string }) {
  const [state, formAction] = useActionState(addStageAction, initialActionState);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="pipelineId" value={pipelineId} />
      <div className="grid-3">
        <Field id={`stage-name-${pipelineId}`} label="Nueva etapa" name="name" maxLength={60} />
        <div className="field">
          <label className="label" htmlFor={`k-${pipelineId}`}>Tipo</label>
          <select id={`k-${pipelineId}`} name="kind" className="select" defaultValue="open">
            <option value="open">Abierta</option><option value="won">Ganada</option><option value="lost">Perdida</option>
          </select>
        </div>
        <Field id={`stage-prob-${pipelineId}`} label="Probabilidad % (abiertas)" name="probability" required={false} inputMode="numeric" placeholder="40" />
      </div>
      <div><SubmitButton className="btn btn-secondary btn-sm" pendingLabel="Agregando…">Agregar etapa</SubmitButton></div>
    </form>
  );
}
