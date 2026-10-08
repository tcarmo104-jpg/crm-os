'use client';

import { useActionState, useState } from 'react';
import { initialActionState } from '@/lib/action-state';
import { STANDARD_FIELD_SUGGESTIONS, WIDGET_FIELD_TYPE_LABELS, type WidgetFieldType } from '@/lib/widget-fields';
import { SubmitButton } from './ui';
import { Feedback, Field } from './forms';
import { createWidgetFieldAction } from '@/app/(app)/settings/whatsapp-widgets/fields/actions';

export function WidgetFieldForm({ existingKeys }: { existingKeys: string[] }) {
  const [state, formAction] = useActionState(createWidgetFieldAction, initialActionState);
  const [label, setLabel] = useState('');
  const [type, setType] = useState<WidgetFieldType>('text');
  const isList = type === 'select';
  // Sugerencias que todavía no están en el catálogo (comparando por el nombre tal cual lo generaría la clave).
  const available = STANDARD_FIELD_SUGGESTIONS.filter((s) => !existingKeys.includes(keyGuess(s.label)));

  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      {available.length > 0 ? (
        <div className="field">
          <label className="label">Agregar uno de los campos sugeridos</label>
          <div className="inline-form" style={{ flexWrap: 'wrap', gap: 6 }}>
            {available.map((s) => (
              <button key={s.label} type="button" className="btn btn-ghost btn-sm"
                onClick={() => { setLabel(s.label); setType(s.type); }}>
                + {s.label}
              </button>
            ))}
          </div>
          <p className="hint">Elige uno para prellenar el formulario de abajo, revisa el tipo y pulsa «Crear campo».</p>
        </div>
      ) : null}

      <div className="grid-3">
        <Field label="Nombre del campo" name="label" value={label} onChange={setLabel} maxLength={80} placeholder="Presupuesto" />
        <div className="field">
          <label className="label" htmlFor="wff-type">Tipo</label>
          <select id="wff-type" name="fieldType" className="select" value={type} onChange={(e) => setType(e.target.value as WidgetFieldType)}>
            {Object.entries(WIDGET_FIELD_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <Field label="Placeholder (opcional)" name="placeholder" maxLength={160} required={false} placeholder="Ej. Tu nombre completo" />
      </div>
      {isList ? (
        <div className="field">
          <label className="label" htmlFor="wff-options">Opciones (una por línea)</label>
          <textarea id="wff-options" name="options" className="input" rows={4} maxLength={5000} required />
        </div>
      ) : null}
      <p className="hint">El nombre y el tipo no se pueden cambiar después (otras intenciones podrían depender de ellos); sí puedes editar la etiqueta y desactivarlo.</p>
      <div><SubmitButton pendingLabel="Creando…">Crear campo</SubmitButton></div>
    </form>
  );
}

// Misma transformación que `keyFromLabel` en el servidor, solo para decidir qué sugerencias ya están usadas.
function keyGuess(label: string): string {
  return label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40).replace(/_+$/, '');
}
