'use client';

import { useActionState } from 'react';
import { initialActionState } from '@/lib/action-state';
import { MESSAGE_TEMPLATE_VARIABLES } from '@/lib/widget-fields';
import { Feedback, Field } from './forms';
import { SubmitButton } from './ui';
import { createWidgetOptionAction } from '@/app/(app)/settings/whatsapp-widgets/[id]/options-actions';

export function WidgetOptionForm({ widgetId }: { widgetId: string }) {
  const [state, formAction] = useActionState(createWidgetOptionAction, initialActionState);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="widgetId" value={widgetId} />
      <div className="grid-2">
        <Field label="Icono (un emoji, opcional)" name="icon" maxLength={16} required={false} placeholder="🛒" />
        <Field label="Nombre de la opción" name="label" maxLength={60} placeholder="Quiero comprar" />
      </div>
      <div className="field">
        <label className="label" htmlFor="wo-template">Mensaje a WhatsApp de esta opción (opcional)</label>
        <textarea id="wo-template" name="messageTemplate" className="input" rows={2} maxLength={1000} placeholder="Hola, soy {{nombre}}. Quiero comprar {{producto}}." />
        <p className="hint">Si lo dejas vacío, usa el mensaje general del widget. Variables: {MESSAGE_TEMPLATE_VARIABLES.map((v) => <code key={v} style={{ marginRight: 6 }}>{`{{${v}}}`}</code>)}</p>
      </div>
      <div><SubmitButton pendingLabel="Creando…">Agregar opción</SubmitButton></div>
    </form>
  );
}
