'use client';

import { useActionState, useState, type ReactNode } from 'react';
import { initialActionState } from '@/lib/action-state';
import {
  ACTION_LABEL, AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS, CONDITION_OP_LABEL, CONDITION_OPS,
  TASK_TYPE_LABEL, TASK_TYPES, TRIGGER_FIELDS, TRIGGER_LABEL, type AutomationAction, type AutomationTrigger,
} from '@/lib/automations';
import { PRIORITY_LABEL } from '@/lib/tasks';
import { Feedback, Field } from '@/components/forms';
import { Modal, SubmitButton } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { createRuleAction } from '@/app/(app)/automations/actions';
import type { Opt } from '@/components/tasks/TaskModals';

interface DraftCondition { field: string; op: string; value: string }
interface DraftAction { type: AutomationAction; [k: string]: unknown }
const emptyAction = (): DraftAction => ({ type: 'add_tag' });

function ActionFields({ i, action, update, people, sequences }: { i: number; action: DraftAction; update: (patch: Partial<DraftAction>) => void; people: Opt[]; sequences: Opt[] }) {
  if (action.type === 'create_task') return (
    <div className="grid-2">
      <Field label="Título de la tarea" name="actTaskTitle" maxLength={160} id={`at-title-${i}`} placeholder="Enviar bienvenida" />
      <div className="field">
        <label className="label" htmlFor={`at-type-${i}`}>Tipo</label>
        <select id={`at-type-${i}`} name="actTaskType" className="select" defaultValue="follow_up">
          {TASK_TYPES.map((t) => <option key={t} value={t}>{TASK_TYPE_LABEL[t]}</option>)}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor={`at-pr-${i}`}>Prioridad</label>
        <select id={`at-pr-${i}`} name="actTaskPriority" className="select" defaultValue="normal">
          {Object.entries(PRIORITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <Field label="Días después" name="actTaskOffset" type="number" defaultValue="0" id={`at-off-${i}`} required={false} />
    </div>
  );
  if (action.type === 'add_tag') return <Field label="Nombre de la etiqueta" name="actTagName" maxLength={40} id={`at-tag-${i}`} placeholder="VIP" />;
  if (action.type === 'assign_owner') return (
    <div className="field">
      <label className="label" htmlFor={`at-owner-${i}`}>Responsable</label>
      <select id={`at-owner-${i}`} name="actOwnerId" className="select" required defaultValue="">
        <option value="" disabled>Elige a quién asignar</option>
        {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div>
  );
  if (action.type === 'enroll_sequence') return (
    <div className="field">
      <label className="label" htmlFor={`at-seq-${i}`}>Secuencia</label>
      <select id={`at-seq-${i}`} name="actSequenceId" className="select" required defaultValue="">
        <option value="" disabled>Elige una secuencia</option>
        {sequences.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </div>
  );
  return null;
}

/** «+ Nueva automatización»: disparador, condiciones opcionales (todas deben cumplirse) y una o más acciones. */
export function NewRuleModal({ trigger, people, sequences }: { trigger: ReactNode; people: Opt[]; sequences: Opt[] }) {
  const [state, formAction] = useActionState(createRuleAction, initialActionState);
  const [selectedTrigger, setSelectedTrigger] = useState<AutomationTrigger>('lead.created');
  const [conditions, setConditions] = useState<DraftCondition[]>([]);
  const [actions, setActions] = useState<DraftAction[]>([emptyAction()]);
  const fields = TRIGGER_FIELDS[selectedTrigger];

  return (
    <Modal title="Nueva automatización" trigger={trigger} wide>
      <form action={formAction} className="stack" noValidate>
        <Feedback state={state} />
        <Field label="Nombre" name="name" maxLength={120} placeholder="Etiquetar leads de feria" autoFocus />

        <div className="field">
          <label className="label" htmlFor="rl-trigger">Cuándo</label>
          <select id="rl-trigger" name="trigger" className="select" value={selectedTrigger} onChange={(e) => { setSelectedTrigger(e.target.value as AutomationTrigger); setConditions([]); }}>
            {AUTOMATION_TRIGGERS.map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>)}
          </select>
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <span className="label">Condiciones (opcionales; deben cumplirse todas)</span>
          {conditions.length === 0 ? <p className="hint">Sin condiciones: la regla aplica siempre que ocurra el disparador.</p> : null}
          <ol className="step-list">
            {conditions.map((c, i) => (
              <li key={i} className="step-form">
                <div className="field">
                  <label className="label small" htmlFor={`cf-${i}`}>Campo</label>
                  <select id={`cf-${i}`} name="condField" className="select" defaultValue={fields[0]?.field}>
                    {fields.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label className="label small" htmlFor={`co-${i}`}>Condición</label>
                  <select id={`co-${i}`} name="condOp" className="select" defaultValue="eq">
                    {CONDITION_OPS.map((op) => <option key={op} value={op}>{CONDITION_OP_LABEL[op]}</option>)}
                  </select>
                </div>
                <Field label="Valor" name="condValue" maxLength={200} id={`cv-${i}`} required={false} />
                <button type="button" className="btn btn-ghost btn-sm" aria-label={`Quitar la condición ${i + 1}`} onClick={() => setConditions((arr) => arr.filter((_, idx) => idx !== i))}>
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setConditions((arr) => [...arr, { field: fields[0]?.field ?? '', op: 'eq', value: '' }])}>+ Agregar condición</button>
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <span className="label">Entonces</span>
          <ol className="step-list">
            {actions.map((a, i) => (
              <li key={i} className="step-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                <div className="inline-form" style={{ justifyContent: 'space-between' }}>
                  <select name="actType" className="select" style={{ maxWidth: 260 }} value={a.type} onChange={(e) => setActions((arr) => arr.map((x, idx) => (idx === i ? { type: e.target.value as AutomationAction } : x)))}>
                    {AUTOMATION_ACTIONS.map((t) => <option key={t} value={t}>{ACTION_LABEL[t]}</option>)}
                  </select>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={actions.length === 1} aria-label={`Quitar la acción ${i + 1}`} onClick={() => setActions((arr) => arr.filter((_, idx) => idx !== i))}>
                    <Icon name="x" size={14} />
                  </button>
                </div>
                <ActionFields i={i} action={a} update={(patch) => setActions((arr) => arr.map((x, idx) => (idx === i ? { ...x, ...patch } : x)))} people={people} sequences={sequences} />
              </li>
            ))}
          </ol>
          <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setActions((arr) => [...arr, emptyAction()])}>+ Agregar acción</button>
        </div>

        <SubmitButton pendingLabel="Creando…">Crear automatización</SubmitButton>
      </form>
    </Modal>
  );
}
