'use client';

import { useActionState, useState } from 'react';
import { initialActionState } from '@/lib/action-state';
import { FIELD_TYPE_LABELS } from '@/lib/custom-fields';
import { SubmitButton } from './ui';
import { Feedback, Field } from './forms';
import { createFieldAction } from '@/app/(app)/settings/fields/actions';

export function FieldForm() {
  const [state, formAction] = useActionState(createFieldAction, initialActionState);
  const [type, setType] = useState('text');
  const isList = type === 'select' || type === 'multi_select';
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <div className="grid-3">
        <div className="field">
          <label className="label" htmlFor="f-entity">Se usa en</label>
          <select id="f-entity" name="entity" className="select" defaultValue="customer">
            <option value="customer">Clientes</option><option value="lead">Leads</option><option value="opportunity">Oportunidades</option>
          </select>
        </div>
        <Field label="Nombre del campo" name="label" maxLength={80} placeholder="Presupuesto mensual" />
        <div className="field">
          <label className="label" htmlFor="f-type">Tipo</label>
          <select id="f-type" name="type" className="select" value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(FIELD_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </div>
      {isList ? (
        <div className="field">
          <label className="label" htmlFor="f-options">Opciones (una por línea)</label>
          <textarea id="f-options" name="options" className="input" rows={4} maxLength={5000} required />
        </div>
      ) : null}
      <p className="hint">El nombre y el tipo no se pueden cambiar después (protegen los datos ya guardados); sí puedes archivar el campo.</p>
      <div><SubmitButton pendingLabel="Creando…">Crear campo</SubmitButton></div>
    </form>
  );
}
