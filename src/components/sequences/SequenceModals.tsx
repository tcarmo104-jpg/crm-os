'use client';

import { useActionState, useState, type ReactNode } from 'react';
import { initialActionState } from '@/lib/action-state';
import { SEQUENCE_STEP_TYPE_LABEL, SEQUENCE_STEP_TYPES } from '@/lib/sequences';
import { Feedback, Field } from '@/components/forms';
import { Modal, SubmitButton } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { createSequenceAction, enrollAction } from '@/app/(app)/sequences/actions';
import type { Opt, OppOpt } from '@/components/tasks/TaskModals';

interface DraftStep { title: string; type: string; offsetDays: number; priority: string }
const emptyStep = (): DraftStep => ({ title: '', type: 'follow_up', offsetDays: 0, priority: 'normal' });

/** «+ Nueva secuencia»: nombre, descripción y una lista de pasos que se arma en el momento (agregar/quitar). */
export function NewSequenceModal({ trigger }: { trigger: ReactNode }) {
  const [state, formAction] = useActionState(createSequenceAction, initialActionState);
  const [steps, setSteps] = useState<DraftStep[]>([emptyStep()]);
  const update = (i: number, patch: Partial<DraftStep>) => setSteps((s) => s.map((st, idx) => (idx === i ? { ...st, ...patch } : st)));
  return (
    <Modal title="Nueva secuencia" trigger={trigger} wide>
      <form action={formAction} className="stack" noValidate>
        <Feedback state={state} />
        <Field label="Nombre" name="name" maxLength={120} placeholder="Bienvenida a un cliente nuevo" autoFocus />
        <div className="field">
          <label className="label" htmlFor="sq-desc">Descripción</label>
          <textarea id="sq-desc" name="description" className="input" rows={2} maxLength={2000} placeholder="Para qué sirve esta secuencia (opcional)" />
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <span className="label">Pasos</span>
          <ol className="step-list">
            {steps.map((s, i) => (
              <li key={i} className="step-form">
                <div className="field">
                  <label className="label small" htmlFor={`st-title-${i}`}>Paso {i + 1}</label>
                  <input id={`st-title-${i}`} name="stepTitle" className="input" maxLength={160} placeholder="Llamar para dar la bienvenida" value={s.title} onChange={(e) => update(i, { title: e.target.value })} />
                </div>
                <div className="field">
                  <label className="label small" htmlFor={`st-type-${i}`}>Tipo</label>
                  <select id={`st-type-${i}`} name="stepType" className="select" value={s.type} onChange={(e) => update(i, { type: e.target.value })}>
                    {SEQUENCE_STEP_TYPES.map((t) => <option key={t} value={t}>{SEQUENCE_STEP_TYPE_LABEL[t]}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label className="label small" htmlFor={`st-off-${i}`}>Días después</label>
                  <input id={`st-off-${i}`} name="stepOffset" type="number" min={0} max={365} className="input" value={s.offsetDays} onChange={(e) => update(i, { offsetDays: Number(e.target.value) })} />
                </div>
                <input type="hidden" name="stepPriority" value={s.priority} />
                <button type="button" className="btn btn-ghost btn-sm" aria-label={`Quitar el paso ${i + 1}`} disabled={steps.length === 1} onClick={() => setSteps((arr) => arr.filter((_, idx) => idx !== i))}>
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setSteps((arr) => [...arr, emptyStep()])}>+ Agregar paso</button>
        </div>

        <SubmitButton pendingLabel="Creando…">Crear secuencia</SubmitButton>
      </form>
    </Modal>
  );
}

/** Inscribir a un cliente en una secuencia activa (desde su ficha). */
export function EnrollModal({ trigger, customerId, sequences, opportunities, people }: { trigger: ReactNode; customerId: string; sequences: { id: string; name: string }[]; opportunities: OppOpt[]; people: Opt[] }) {
  const [state, formAction] = useActionState(enrollAction, initialActionState);
  const custOpps = opportunities.filter((o) => o.customerId === customerId);
  if (sequences.length === 0) return null;
  return (
    <Modal title="Inscribir en una secuencia" trigger={trigger}>
      <form action={formAction} className="stack" noValidate>
        <Feedback state={state} />
        <input type="hidden" name="customerId" value={customerId} />
        <div className="field">
          <label className="label" htmlFor="en-seq">Secuencia</label>
          <select id="en-seq" name="sequenceId" className="select" required defaultValue="">
            <option value="" disabled>Elige una secuencia</option>
            {sequences.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        {custOpps.length > 0 ? (
          <div className="field">
            <label className="label" htmlFor="en-opp">Oportunidad relacionada</label>
            <select id="en-opp" name="opportunityId" className="select" defaultValue="">
              <option value="">Sin oportunidad</option>
              {custOpps.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
            </select>
          </div>
        ) : null}
        {people.length > 0 ? (
          <div className="field">
            <label className="label" htmlFor="en-asg">Responsable de los pasos</label>
            <select id="en-asg" name="assigneeId" className="select" defaultValue="">
              <option value="">El responsable del cliente</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        ) : null}
        <p className="hint">Se crea de inmediato la tarea del primer paso. Los siguientes se van creando solos, a medida que completas cada uno.</p>
        <SubmitButton pendingLabel="Inscribiendo…">Inscribir</SubmitButton>
      </form>
    </Modal>
  );
}
