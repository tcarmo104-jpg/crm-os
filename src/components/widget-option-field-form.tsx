'use client';

import { useActionState, useState } from 'react';
import { initialActionState, type ActionState } from '@/lib/action-state';
import type { WidgetFieldRow } from '@/repositories/widget-fields';
import { Feedback, Field } from './forms';
import { SubmitButton } from './ui';

/** Editar nombre/icono/mensaje de la intención en sí (no sus campos). */
export function EditWidgetOptionForm({
  widgetId, optionId, initial, action,
}: { widgetId: string; optionId: string; initial: { icon: string | null; label: string; messageTemplate: string | null }; action: (prev: ActionState, fd: FormData) => Promise<ActionState> }) {
  const [state, formAction] = useActionState(action, initialActionState);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="widgetId" value={widgetId} />
      <input type="hidden" name="optionId" value={optionId} />
      <div className="grid-2">
        <Field label="Icono (un emoji, opcional)" name="icon" defaultValue={initial.icon ?? ''} maxLength={16} required={false} />
        <Field label="Nombre de la opción" name="label" defaultValue={initial.label} maxLength={60} />
      </div>
      <div className="field">
        <label className="label" htmlFor="eo-template">Mensaje a WhatsApp de esta opción (opcional)</label>
        <textarea id="eo-template" name="messageTemplate" className="input" rows={2} maxLength={1000} defaultValue={initial.messageTemplate ?? ''} />
      </div>
      <SubmitButton pendingLabel="Guardando…">Guardar cambios</SubmitButton>
    </form>
  );
}

/** Agregar un campo del catálogo a esta intención. */
export function AddOptionFieldForm({
  widgetId, optionId, available, action,
}: { widgetId: string; optionId: string; available: WidgetFieldRow[]; action: (prev: ActionState, fd: FormData) => Promise<ActionState> }) {
  const [state, formAction] = useActionState(action, initialActionState);
  const [fieldId, setFieldId] = useState(available[0]?.id ?? '');
  if (available.length === 0) return <p className="muted small">Ya agregaste todos los campos activos del catálogo. <a href="/settings/whatsapp-widgets/fields">Crea uno nuevo →</a></p>;
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="widgetId" value={widgetId} />
      <input type="hidden" name="optionId" value={optionId} />
      <div className="grid-3">
        <div className="field">
          <label className="label" htmlFor="aof-field">Campo</label>
          <select id="aof-field" name="fieldId" className="select" value={fieldId} onChange={(e) => setFieldId(e.target.value)}>
            {available.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>
        <Field label="Etiqueta propia (opcional)" name="labelOverride" maxLength={80} required={false} hint="Si lo dejas vacío, usa la del catálogo." />
        <Field label="Placeholder propio (opcional)" name="placeholderOverride" maxLength={160} required={false} />
      </div>
      <label className="inline-form" style={{ gap: 8 }}>
        <input type="checkbox" name="required" />
        Obligatorio en esta intención
      </label>
      <div><SubmitButton pendingLabel="Agregando…">Agregar campo</SubmitButton></div>
    </form>
  );
}
