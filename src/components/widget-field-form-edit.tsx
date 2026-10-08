'use client';

import { useActionState, useState } from 'react';
import { initialActionState, type ActionState } from '@/lib/action-state';
import type { WidgetFieldRow } from '@/repositories/widget-fields';
import { Feedback, Field } from './forms';
import { SubmitButton } from './ui';

export function EditWidgetFieldForm({ field, action }: { field: WidgetFieldRow; action: (prev: ActionState, fd: FormData) => Promise<ActionState> }) {
  const [state, formAction] = useActionState(action, initialActionState);
  const [label, setLabel] = useState(field.label);
  const isList = field.fieldType === 'select';

  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="fieldId" value={field.id} />
      <Field label="Nombre del campo" name="label" value={label} onChange={setLabel} maxLength={80} />
      <Field label="Placeholder (opcional)" name="placeholder" defaultValue={field.placeholder ?? ''} maxLength={160} required={false} />
      {isList ? (
        <div className="field">
          <label className="label" htmlFor="wffe-options">Opciones (una por línea)</label>
          <textarea id="wffe-options" name="options" className="input" rows={4} maxLength={5000} defaultValue={field.options.join('\n')} required />
        </div>
      ) : null}
      <SubmitButton pendingLabel="Guardando…">Guardar cambios</SubmitButton>
    </form>
  );
}
