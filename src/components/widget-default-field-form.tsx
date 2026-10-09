'use client';

import { useActionState, useState } from 'react';
import { initialActionState, type ActionState } from '@/lib/action-state';
import type { WidgetFieldRow } from '@/repositories/widget-fields';
import { Feedback, Field } from './forms';
import { SubmitButton } from './ui';

/** Agregar un campo del catálogo al formulario BASE del widget (Entrega 4): el que el visitante siempre ve. */
export function AddDefaultFieldForm({
  widgetId, available, action,
}: { widgetId: string; available: WidgetFieldRow[]; action: (prev: ActionState, fd: FormData) => Promise<ActionState> }) {
  const [state, formAction] = useActionState(action, initialActionState);
  const [fieldId, setFieldId] = useState(available[0]?.id ?? '');
  if (available.length === 0) return <p className="muted small">Ya agregaste todos los campos activos del catálogo. <a href="/settings/whatsapp-widgets/fields">Crea uno nuevo →</a></p>;
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="widgetId" value={widgetId} />
      <div className="grid-3">
        <div className="field">
          <label className="label" htmlFor="adf-field">Campo</label>
          <select id="adf-field" name="fieldId" className="select" value={fieldId} onChange={(e) => setFieldId(e.target.value)}>
            {available.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>
        <Field label="Etiqueta propia (opcional)" name="labelOverride" maxLength={80} required={false} hint="Si lo dejas vacío, usa la del catálogo." />
        <Field label="Placeholder propio (opcional)" name="placeholderOverride" maxLength={160} required={false} />
      </div>
      <label className="inline-form" style={{ gap: 8 }}>
        <input type="checkbox" name="required" />
        Obligatorio para continuar
      </label>
      <div><SubmitButton pendingLabel="Agregando…">Agregar campo</SubmitButton></div>
    </form>
  );
}
