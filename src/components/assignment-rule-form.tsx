'use client';

import { useActionState } from 'react';
import { initialActionState, type ActionState } from '@/lib/action-state';
import { CHANNEL_KIND_LABEL, CHANNEL_KINDS, WEEKDAYS, WEEKDAY_LABEL } from '@/lib/assignment-rules';
import { Feedback, Field } from './forms';
import { SubmitButton } from './ui';
import type { AssignmentRuleRow } from '@/repositories/assignment-rules';

export function AssignmentRuleForm({
  mode, ruleId, initial, teams, widgets, action,
}: {
  mode: 'create' | 'edit'; ruleId?: string; initial?: AssignmentRuleRow; teams: { id: string; name: string; region: string | null }[];
  widgets: { id: string; name: string }[]; action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const hasHours = Boolean(initial?.hoursStart);

  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      {ruleId ? <input type="hidden" name="ruleId" value={ruleId} /> : null}

      <Field label="Nombre de la regla" name="name" defaultValue={initial?.name} maxLength={80} placeholder="Todo a Bogotá" autoFocus />

      <div className="grid-2">
        <div className="field">
          <label className="label" htmlFor="ar-team">Equipo que recibe</label>
          <select id="ar-team" name="teamId" className="select" defaultValue={initial?.teamId ?? ''} required>
            <option value="" disabled>Elige un equipo</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}{t.region ? ` (${t.region})` : ''}</option>)}
          </select>
          <p className="hint">Se reparte por turnos entre los integrantes activos de ese equipo.</p>
        </div>
        <div className="field">
          <label className="label" htmlFor="ar-priority">Prioridad</label>
          <input id="ar-priority" name="priority" type="number" min={1} max={9999} className="input" defaultValue={initial?.priority ?? 100} required />
          <p className="hint">Menor número = se evalúa primero.</p>
        </div>
      </div>

      <div className="grid-2">
        <div className="field">
          <label className="label" htmlFor="ar-channel">Canal (opcional)</label>
          <select id="ar-channel" name="channelKind" className="select" defaultValue={initial?.channelKind ?? ''}>
            <option value="">Cualquier canal</option>
            {CHANNEL_KINDS.map((k) => <option key={k} value={k}>{CHANNEL_KIND_LABEL[k]}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="ar-widget">Widget de WhatsApp (opcional)</label>
          <select id="ar-widget" name="widgetId" className="select" defaultValue={initial?.widgetId ?? ''}>
            <option value="">Cualquier widget</option>
            {widgets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
      </div>

      <Field label="Región (opcional)" name="region" defaultValue={initial?.region ?? ''} maxLength={80} placeholder="Bogotá" hint="Se compara con la región configurada en cada widget (sin importar mayúsculas). Deja vacío para que aplique a cualquier región." required={false} />

      <fieldset className="field">
        <legend className="label">Horario (opcional — vacío = atiende siempre)</legend>
        <div className="grid-2">
          <Field label="Desde" name="hoursStart" type="time" defaultValue={initial?.hoursStart?.slice(0, 5) ?? ''} required={false} />
          <Field label="Hasta" name="hoursEnd" type="time" defaultValue={initial?.hoursEnd?.slice(0, 5) ?? ''} required={false} />
        </div>
        <div className="inline-form" style={{ flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
          {WEEKDAYS.map((d) => (
            <label key={d} className="inline-form" style={{ gap: 4 }}>
              <input type="checkbox" name="hoursDays" value={d} defaultChecked={initial ? initial.hoursDays.includes(d) : true} />
              {WEEKDAY_LABEL[d]}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="inline-form" style={{ gap: 8 }}>
        <input type="checkbox" name="active" defaultChecked={initial?.active ?? true} />
        Regla activa
      </label>

      <SubmitButton pendingLabel="Guardando…">{mode === 'create' ? 'Crear regla' : 'Guardar cambios'}</SubmitButton>
    </form>
  );
}
