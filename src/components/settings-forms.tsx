'use client';

import { useActionState } from 'react';
import { initialActionState } from '@/lib/action-state';
import { Feedback, Field } from './forms';
import { SubmitButton } from './ui';
import { updateGeneralSettingsAction } from '@/app/(app)/settings/general/actions';

export function GeneralSettingsForm({
  defaultValues, timezones, locales,
}: { defaultValues: { name: string; timezone: string; locale: string; currency: string }; timezones: readonly string[]; locales: readonly { value: string; label: string }[] }) {
  const [state, formAction] = useActionState(updateGeneralSettingsAction, initialActionState);
  return (
    <form action={formAction} className="stack" noValidate style={{ maxWidth: 480 }}>
      <Feedback state={state} />
      <Field label="Nombre de la organización" name="name" defaultValue={defaultValues.name} maxLength={120} autoFocus />
      <div className="field">
        <label className="label" htmlFor="gs-timezone">Zona horaria</label>
        <select id="gs-timezone" name="timezone" className="select" defaultValue={defaultValues.timezone}>
          {timezones.map((tz) => <option key={tz} value={tz}>{tz.replace('_', ' ')}</option>)}
        </select>
        <p className="hint">Se usa para calcular «hoy», vencimientos y horarios en todo el CRM.</p>
      </div>
      <div className="field">
        <label className="label" htmlFor="gs-locale">Idioma y formato</label>
        <select id="gs-locale" name="locale" className="select" defaultValue={defaultValues.locale}>
          {locales.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
      </div>
      <Field label="Moneda (código de 3 letras)" name="currency" defaultValue={defaultValues.currency} maxLength={3} placeholder="COP" hint="Por ejemplo: COP, USD, MXN, ARS, CLP, PEN." />
      <SubmitButton pendingLabel="Guardando…">Guardar cambios</SubmitButton>
    </form>
  );
}
