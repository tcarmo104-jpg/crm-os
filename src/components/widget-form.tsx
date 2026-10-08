'use client';

import { useActionState, useState } from 'react';
import { initialActionState, type ActionState } from '@/lib/action-state';
import { POSITION_LABEL, SIZE_LABEL, WIDGET_POSITIONS, WIDGET_SIZES } from '@/lib/widgets';
import { MESSAGE_TEMPLATE_VARIABLES } from '@/lib/widget-fields';
import { Feedback, Field } from './forms';
import { SubmitButton } from './ui';
import type { WidgetRow } from '@/repositories/widgets';

export function WidgetForm({
  mode, widgetId, initial, channels, action,
}: {
  mode: 'create' | 'edit'; widgetId?: string; initial?: WidgetRow; channels: { id: string; name: string; displayPhone: string | null }[];
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const [color, setColor] = useState(initial?.color ?? '#25D366');

  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      {widgetId ? <input type="hidden" name="widgetId" value={widgetId} /> : null}

      <Field label="Nombre interno" name="name" defaultValue={initial?.name} maxLength={80} placeholder="Web principal" autoFocus hint="Solo para identificarlo en esta lista; el visitante nunca lo ve." />

      <div className="field">
        <label className="label" htmlFor="wf-channel">Número de WhatsApp</label>
        <select id="wf-channel" name="channelId" className="select" defaultValue={initial?.channelId ?? ''} required>
          <option value="" disabled>Elige un número conectado</option>
          {channels.map((c) => <option key={c.id} value={c.id}>{c.name}{c.displayPhone ? ` (${c.displayPhone})` : ''}</option>)}
        </select>
        {channels.length === 0 ? <p className="notice notice-error">No tienes ningún número de WhatsApp conectado todavía. Conecta uno en Conexiones primero.</p> : null}
      </div>

      <div className="grid-2">
        <Field label="Texto del botón" name="buttonText" defaultValue={initial?.buttonText ?? 'Escríbenos'} maxLength={40} />
        <div className="field">
          <label className="label" htmlFor="wf-position">Posición</label>
          <select id="wf-position" name="position" className="select" defaultValue={initial?.position ?? 'bottom-right'}>
            {WIDGET_POSITIONS.map((p) => <option key={p} value={p}>{POSITION_LABEL[p]}</option>)}
          </select>
        </div>
      </div>

      <div className="field">
        <label className="label" htmlFor="wf-msg">Mensaje de bienvenida (opcional)</label>
        <textarea id="wf-msg" name="initialMessage" className="input" rows={2} maxLength={300} defaultValue={initial?.initialMessage ?? ''} placeholder="Hola 👋 ¿en qué te podemos ayudar?" />
      </div>

      <div className="grid-2">
        <div className="field">
          <label className="label" htmlFor="wf-color">Color</label>
          <div className="inline-form">
            <input id="wf-color" type="color" name="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 44, height: 36, padding: 2 }} />
            <span className="small muted">{color}</span>
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="wf-size">Tamaño</label>
          <select id="wf-size" name="size" className="select" defaultValue={initial?.size ?? 'medium'}>
            {WIDGET_SIZES.map((s) => <option key={s} value={s}>{SIZE_LABEL[s]}</option>)}
          </select>
        </div>
      </div>

      <label className="inline-form" style={{ gap: 8 }}>
        <input type="checkbox" name="showText" defaultChecked={initial?.showText ?? true} />
        Mostrar el texto junto al ícono
      </label>

      <div className="field">
        <label className="label" htmlFor="wf-domains">Dominios autorizados</label>
        <textarea id="wf-domains" name="domains" className="input" rows={3} defaultValue={initial?.allowedDomains.join('\n') ?? ''} placeholder="arkos.com.co&#10;tienda.arkos.com.co" required />
        <p className="hint">Uno por línea (o separados por coma). El widget solo va a funcionar en estos dominios y sus subdominios.</p>
      </div>

      <Field label="Región (opcional)" name="region" defaultValue={initial?.region ?? ''} maxLength={80} placeholder="Medellín" required={false}
        hint="La sede o región de la web donde se instala este widget. Las reglas de distribución con esa región asignan sus contactos al equipo que corresponda. El visitante no ve ni escribe nada." />

      <div className="field">
        <label className="label" htmlFor="wf-template">Mensaje a WhatsApp (opcional)</label>
        <textarea id="wf-template" name="messageTemplate" className="input" rows={3} maxLength={1000} defaultValue={initial?.messageTemplate ?? ''}
          placeholder={'Hola, soy {{nombre}}. {{mensaje}}'} />
        <p className="hint">
          El mensaje con el que llega el visitante a WhatsApp. Si lo dejas vacío, se usa el formato de siempre. Variables disponibles:{' '}
          {MESSAGE_TEMPLATE_VARIABLES.map((v) => <code key={v} style={{ marginRight: 6 }}>{`{{${v}}}`}</code>)}
          — una intención (más abajo) puede tener su propio mensaje y usar estas mismas variables.
        </p>
      </div>

      <SubmitButton pendingLabel="Guardando…">{mode === 'create' ? 'Crear widget' : 'Guardar cambios'}</SubmitButton>
    </form>
  );
}
