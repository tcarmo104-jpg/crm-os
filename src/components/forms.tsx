'use client';

import Link from 'next/link';
import { useActionState, useState, type ReactNode } from 'react';
import { initialActionState, type ActionState } from '@/lib/action-state';
import { slugify } from '@/lib/slug';
import { CopyField, Notice, SubmitButton } from './ui';
import { forgotPassword, login, resetPassword, signup } from '@/app/auth-actions';
import { createOrg } from '@/app/(focus)/onboarding/actions';
import { inviteMember } from '@/app/(app)/settings/members/actions';
import { createTeam } from '@/app/(app)/settings/teams/actions';

type Action = (prev: ActionState, fd: FormData) => Promise<ActionState>;

export function Field({
  label, name, type = 'text', autoComplete, hint, defaultValue, value, onChange, required = true, minLength, maxLength, placeholder, id: idProp, inputMode, list,
}: {
  label: string; name: string; type?: string; autoComplete?: string; hint?: string;
  defaultValue?: string; value?: string; onChange?: (v: string) => void;
  required?: boolean; minLength?: number; maxLength?: number; placeholder?: string;
  /** Cuando hay dos formularios con el mismo `name` en una página, el id debe ser único. */
  id?: string; inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email' | 'url' | 'search';
  /** id de un <datalist> con sugerencias (autocompletar sin restringir lo que se puede escribir). */
  list?: string;
}) {
  const id = idProp ?? `f-${name}`;
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <input
        id={id} name={name} type={type} className="input" autoComplete={autoComplete} list={list}
        required={required} minLength={minLength} maxLength={maxLength} placeholder={placeholder} inputMode={inputMode}
        {...(value !== undefined ? { value, onChange: (e) => onChange?.(e.target.value) } : { defaultValue })}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint ? <p className="hint" id={`${id}-hint`}>{hint}</p> : null}
    </div>
  );
}

export function Feedback({ state }: { state: ActionState }) {
  if (state.error) return <Notice kind="error">{state.error}</Notice>;
  if (state.ok && state.message) return <Notice kind="ok">{state.message}</Notice>;
  return null;
}

export function useForm(action: Action) {
  return useActionState(action, initialActionState);
}

export function LoginForm({ next }: { next: string }) {
  const [state, formAction] = useForm(login);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="next" value={next} />
      <Field label="Correo" name="email" type="email" autoComplete="email" />
      <Field label="Contraseña" name="password" type="password" autoComplete="current-password" />
      <SubmitButton pendingLabel="Entrando…">Iniciar sesión</SubmitButton>
      <p className="muted small"><Link href="/forgot-password">¿Olvidaste tu contraseña?</Link></p>
    </form>
  );
}

export function SignupForm({ next }: { next: string }) {
  const [state, formAction] = useForm(signup);
  if (state.ok) return <Notice kind="ok">{state.message}</Notice>;
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="next" value={next} />
      <Field label="Nombre completo" name="fullName" autoComplete="name" />
      <Field label="Correo" name="email" type="email" autoComplete="email" />
      <Field label="Contraseña" name="password" type="password" autoComplete="new-password" minLength={10} hint="Mínimo 10 caracteres." />
      <SubmitButton pendingLabel="Creando cuenta…">Crear cuenta</SubmitButton>
    </form>
  );
}

export function ForgotForm() {
  const [state, formAction] = useForm(forgotPassword);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <Field label="Correo" name="email" type="email" autoComplete="email" />
      <SubmitButton pendingLabel="Enviando…">Enviar enlace</SubmitButton>
    </form>
  );
}

export function ResetForm() {
  const [state, formAction] = useForm(resetPassword);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <Field label="Contraseña nueva" name="password" type="password" autoComplete="new-password" minLength={10} hint="Mínimo 10 caracteres." />
      <SubmitButton pendingLabel="Guardando…">Guardar contraseña</SubmitButton>
    </form>
  );
}

export function OnboardingForm() {
  const [state, formAction] = useForm(createOrg);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <Field
        label="Nombre de la organización" name="name" value={name} maxLength={120} autoComplete="organization"
        onChange={(v) => { setName(v); if (!touched) setSlug(slugify(v)); }}
      />
      <Field
        label="Identificador" name="slug" value={slug} maxLength={40}
        onChange={(v) => { setTouched(true); setSlug(v.toLowerCase()); }}
        hint="Letras minúsculas, números y guiones. Es único en toda la plataforma."
      />
      <SubmitButton pendingLabel="Creando…">Crear organización</SubmitButton>
    </form>
  );
}

export function InviteForm({
  roles, teams,
}: { roles: { key: string; name: string }[]; teams: { id: string; name: string }[] }) {
  const [state, formAction] = useForm(inviteMember);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      {state.ok && state.data?.link ? (
        <div className="stack">
          <CopyField label="Enlace de invitación" value={state.data.link} />
          <p className="hint">
            Compártelo solo con esa persona. Vence en 7 días y no se volverá a mostrar. El envío automático por correo
            se habilitará cuando se conecte un proveedor de email.
          </p>
        </div>
      ) : null}
      <div className="grid-3">
        <Field label="Correo de la persona" name="email" type="email" autoComplete="off" />
        <div className="field">
          <label className="label" htmlFor="f-roleKey">Rol</label>
          <select id="f-roleKey" name="roleKey" className="select" required defaultValue="sales_agent">
            {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="f-teamId">Equipo (opcional)</label>
          <select id="f-teamId" name="teamId" className="select" defaultValue="">
            <option value="">Sin equipo</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      </div>
      <div><SubmitButton pendingLabel="Creando…">Crear invitación</SubmitButton></div>
    </form>
  );
}

export function TeamForm(): ReactNode {
  const [state, formAction] = useForm(createTeam);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <div className="grid-2">
        <Field label="Nombre del equipo" name="name" maxLength={80} />
        <Field label="Región (opcional)" name="region" required={false} maxLength={80} placeholder="Bogotá, Costa…" />
      </div>
      <div><SubmitButton pendingLabel="Creando…">Crear equipo</SubmitButton></div>
    </form>
  );
}
