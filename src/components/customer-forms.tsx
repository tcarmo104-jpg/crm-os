'use client';

import { useActionState, useState } from 'react';
import { initialActionState } from '@/lib/action-state';
import type { FieldDefinition, CustomerRow } from '@/lib/types';
import { Notice, SubmitButton } from './ui';
import { Feedback, Field } from './forms';
import {
  addIdentifierAction, assignOwnerAction, createCustomerAction, setDoNotContactAction, updateProfileAction,
} from '@/app/(app)/customers/actions';

const CHANNELS = [
  ['whatsapp', 'WhatsApp'], ['phone', 'Llamada'], ['email', 'Correo'], ['instagram', 'Instagram'], ['facebook', 'Facebook'],
] as const;

function ChannelSelect({ defaultValue }: { defaultValue?: string | null }) {
  return (
    <div className="field">
      <label className="label" htmlFor="f-preferredChannel">Canal preferido</label>
      <select id="f-preferredChannel" name="preferredChannel" className="select" defaultValue={defaultValue ?? ''}>
        <option value="">Sin preferencia</option>
        {CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}

export function NewCustomerForm() {
  const [state, formAction] = useActionState(createCustomerAction, initialActionState);
  const [type, setType] = useState<'person' | 'company'>('person');
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label">Tipo</legend>
        <div className="inline-form">
          <label><input type="radio" name="type" value="person" checked={type === 'person'} onChange={() => setType('person')} /> Persona</label>
          <label><input type="radio" name="type" value="company" checked={type === 'company'} onChange={() => setType('company')} /> Empresa</label>
        </div>
      </fieldset>
      <Field label={type === 'company' ? 'Nombre de la empresa' : 'Nombre completo'} name="fullName" maxLength={160} autoComplete="off" />
      <div className="grid-3">
        <Field label="Teléfono / WhatsApp" name="phone" type="tel" required={false} autoComplete="off" />
        <Field label="Correo" name="email" type="email" required={false} autoComplete="off" />
        <Field label="Instagram" name="instagram" required={false} placeholder="@usuario" autoComplete="off" />
      </div>
      <p className="hint">Necesitas al menos un dato de contacto: así reconocemos al cliente cuando vuelva a escribir por cualquier canal.</p>
      <div className="grid-3">
        <Field label="Ciudad" name="city" required={false} maxLength={120} />
        <Field label="País (2 letras)" name="country" required={false} maxLength={2} placeholder="CO" />
        <ChannelSelect />
      </div>
      <div><SubmitButton pendingLabel="Creando…">Crear cliente</SubmitButton></div>
    </form>
  );
}

export function CustomFieldInputs({ defs, values }: { defs: FieldDefinition[]; values: Record<string, unknown> }) {
  const active = defs.filter((d) => !d.archivedAt);
  if (active.length === 0) return null;
  return (
    <>
      {active.map((d) => {
        const id = `cf-${d.key}`;
        const name = `cf_${d.key}`;
        const v = values[d.key];
        let control;
        if (d.type === 'select') {
          control = (
            <select id={id} name={name} className="select" defaultValue={typeof v === 'string' ? v : ''}>
              <option value="">—</option>
              {d.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          );
        } else if (d.type === 'multi_select') {
          const chosen = Array.isArray(v) ? (v as string[]) : [];
          control = (
            <div className="inline-form" role="group" aria-labelledby={`${id}-l`}>
              {d.options.map((o) => (
                <label key={o}><input type="checkbox" name={name} value={o} defaultChecked={chosen.includes(o)} /> {o}</label>
              ))}
            </div>
          );
        } else if (d.type === 'boolean') {
          control = (
            <select id={id} name={name} className="select" defaultValue={typeof v === 'boolean' ? String(v) : ''}>
              <option value="">—</option><option value="true">Sí</option><option value="false">No</option>
            </select>
          );
        } else {
          const inputType = d.type === 'number' || d.type === 'currency' ? 'number' : d.type === 'date' ? 'date' : d.type === 'email' ? 'email' : d.type === 'url' ? 'url' : d.type === 'phone' ? 'tel' : 'text';
          control = <input id={id} name={name} type={inputType} step={inputType === 'number' ? 'any' : undefined} className="input" defaultValue={v === undefined || v === null ? '' : String(v)} />;
        }
        return (
          <div className="field" key={d.key}>
            <label className="label" id={`${id}-l`} htmlFor={id}>{d.label}</label>
            {control}
          </div>
        );
      })}
    </>
  );
}

export function EditProfileForm({
  customer, companies, defs,
}: { customer: CustomerRow; companies: { id: string; fullName: string }[]; defs: FieldDefinition[] }) {
  const [state, formAction] = useActionState(updateProfileAction, initialActionState);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="customerId" value={customer.id} />
      <Field label="Nombre" name="fullName" defaultValue={customer.fullName} maxLength={160} />
      <div className="grid-3">
        <Field label="Ciudad" name="city" required={false} defaultValue={customer.city ?? ''} maxLength={120} />
        <Field label="País (2 letras)" name="country" required={false} defaultValue={customer.country ?? ''} maxLength={2} />
        <ChannelSelect defaultValue={customer.preferredChannel} />
      </div>
      <Field label="Dirección" name="address" required={false} defaultValue={customer.address ?? ''} maxLength={300} />
      {customer.type === 'person' && companies.length > 0 ? (
        <div className="field">
          <label className="label" htmlFor="f-companyId">Empresa</label>
          <select id="f-companyId" name="companyId" className="select" defaultValue={customer.companyId ?? ''}>
            <option value="">Sin empresa</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}
          </select>
        </div>
      ) : null}
      <CustomFieldInputs defs={defs} values={customer.customFields} />
      <div><SubmitButton>Guardar cambios</SubmitButton></div>
    </form>
  );
}

export function DncForm({ customerId, active, reason, canClear }: { customerId: string; active: boolean; reason: string | null; canClear: boolean }) {
  const [state, formAction] = useActionState(setDoNotContactAction, initialActionState);
  if (active && !canClear) {
    return <p className="muted small">Este cliente pidió no ser contactado{reason ? `: «${reason}»` : ''}. Solo un manager o administrador puede quitar esta marca.</p>;
  }
  return (
    <form action={formAction} className="stack">
      <Feedback state={state} />
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="on" value={active ? 'false' : 'true'} />
      {active ? (
        <p className="muted small">Marcado como «no contactar»{reason ? `: «${reason}»` : ''}.</p>
      ) : (
        <Field label="Motivo (opcional)" name="reason" required={false} maxLength={300} />
      )}
      <div>
        <SubmitButton className={active ? 'btn btn-secondary btn-sm' : 'btn btn-danger btn-sm'} pendingLabel="Guardando…">
          {active ? 'Quitar «no contactar»' : 'Marcar como «no contactar»'}
        </SubmitButton>
      </div>
    </form>
  );
}

export function OwnerForm({
  customerId, ownerId, people,
}: { customerId: string; ownerId: string | null; people: { id: string; name: string }[] }) {
  const [state, formAction] = useActionState(assignOwnerAction, initialActionState);
  return (
    <form action={formAction} className="inline-form">
      <input type="hidden" name="customerId" value={customerId} />
      <label className="sr-only" htmlFor="f-ownerId">Responsable</label>
      <select id="f-ownerId" name="ownerId" className="select select-sm" defaultValue={ownerId ?? ''}>
        <option value="">Sin asignar</option>
        {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <SubmitButton className="btn btn-secondary btn-sm">Asignar</SubmitButton>
      {state.error ? <Notice kind="error">{state.error}</Notice> : state.ok ? <span className="muted small">{state.message}</span> : null}
    </form>
  );
}

export function AddIdentifierForm({ customerId }: { customerId: string }) {
  const [state, formAction] = useActionState(addIdentifierAction, initialActionState);
  return (
    <form action={formAction} className="stack">
      <Feedback state={state} />
      <input type="hidden" name="customerId" value={customerId} />
      <div className="inline-form">
        <label className="sr-only" htmlFor="f-idtype">Tipo</label>
        <select id="f-idtype" name="type" className="select select-sm" defaultValue="phone">
          <option value="phone">Teléfono</option><option value="email">Correo</option>
          <option value="instagram">Instagram</option><option value="facebook">Facebook</option>
        </select>
        <label className="sr-only" htmlFor="f-idvalue">Valor</label>
        <input id="f-idvalue" name="value" className="input" required maxLength={254} placeholder="Nuevo dato de contacto" autoComplete="off" />
        <SubmitButton className="btn btn-secondary btn-sm">Agregar</SubmitButton>
      </div>
    </form>
  );
}
