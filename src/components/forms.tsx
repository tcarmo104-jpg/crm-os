'use client';

import Link from 'next/link';
import { useActionState, useState, type ReactNode } from 'react';
import { initialActionState, type ActionState } from '@/lib/action-state';
import { slugify } from '@/lib/slug';
import { CopyField, Notice, SubmitButton } from './ui';
import { Icon } from './Icon';
import { forgotPassword, login, resetPassword, signup } from '@/app/auth-actions';
import { createOrg } from '@/app/(focus)/onboarding/actions';
import { inviteMember } from '@/app/(app)/settings/members/actions';
import { createTeam } from '@/app/(app)/settings/teams/actions';

type Action = (prev: ActionState, fd: FormData) => Promise<ActionState>;

/** Campo de contraseña con un icono para mostrar u ocultar el texto. Oculta por defecto; el ícono nunca envía el formulario. */
export function PasswordField({ label, name, autoComplete, hint, minLength, id: idProp, autoFocus }: { label: string; name: string; autoComplete?: string; hint?: string; minLength?: number; id?: string; autoFocus?: boolean }) {
  const id = idProp ?? `f-${name}`;
  const [visible, setVisible] = useState(false);
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <div className="password-field">
        <input
          id={id} name={name} type={visible ? 'text' : 'password'} className="input" autoComplete={autoComplete} autoFocus={autoFocus}
          required minLength={minLength} aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <button
          type="button" className="password-toggle" onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Ocultar la contraseña' : 'Mostrar la contraseña'} aria-pressed={visible}
        >
          <Icon name={visible ? 'eye-off' : 'eye'} size={18} />
        </button>
      </div>
      {hint ? <p className="hint" id={`${id}-hint`}>{hint}</p> : null}
    </div>
  );
}

export function Field({
  label, name, type = 'text', autoComplete, hint, defaultValue, value, onChange, required = true, minLength, maxLength, placeholder, id: idProp, inputMode, list, autoFocus,
}: {
  label: string; name: string; type?: string; autoComplete?: string; hint?: string;
  defaultValue?: string; value?: string; onChange?: (v: string) => void;
  required?: boolean; minLength?: number; maxLength?: number; placeholder?: string;
  /** Cuando hay dos formularios con el mismo `name` en una página, el id debe ser único. */
  id?: string; inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email' | 'url' | 'search';
  /** id de un <datalist> con sugerencias (autocompletar sin restringir lo que se puede escribir). */
  list?: string;
  autoFocus?: boolean;
}) {
  const id = idProp ?? `f-${name}`;
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <input
        id={id} name={name} type={type} className="input" autoComplete={autoComplete} list={list} autoFocus={autoFocus}
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
  // El campo se maneja como controlado a propósito: React reinicia el formulario de forma nativa después de
  // que la acción del servidor responde (incluso si hay un error), y eso borraría lo escrito si el campo
  // dependiera solo del DOM.
  const [email, setEmail] = useState('');
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="next" value={next} />
      <Field label="Correo electrónico" name="email" type="email" autoComplete="email" autoFocus value={email} onChange={setEmail} />
      <PasswordField label="Contraseña" name="password" autoComplete="current-password" />
      <div className="login-row">
        <label className="checkbox-field">
          <input type="checkbox" name="remember" defaultChecked />
          <span>Recordarme</span>
        </label>
        <Link href="/forgot-password" className="small">¿Olvidaste tu contraseña?</Link>
      </div>
      <SubmitButton pendingLabel="Entrando…">Iniciar sesión</SubmitButton>
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
      <Field label="Nombre completo" name="fullName" autoComplete="name" autoFocus />
      <Field label="Correo electrónico" name="email" type="email" autoComplete="email" />
      <PasswordField label="Contraseña" name="password" autoComplete="new-password" minLength={10} hint="Mínimo 10 caracteres." />
      <SubmitButton pendingLabel="Creando cuenta…">Crear cuenta</SubmitButton>
    </form>
  );
}

export function ForgotForm() {
  const [state, formAction] = useForm(forgotPassword);
  const [email, setEmail] = useState('');
  if (state.ok) return <Notice kind="ok">{state.message}</Notice>;
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <Field label="Correo electrónico" name="email" type="email" autoComplete="email" autoFocus value={email} onChange={setEmail} />
      <SubmitButton pendingLabel="Enviando…">Enviar enlace</SubmitButton>
    </form>
  );
}

export function ResetForm() {
  const [state, formAction] = useForm(resetPassword);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <PasswordField label="Contraseña nueva" name="password" autoComplete="new-password" minLength={10} hint="Mínimo 10 caracteres." autoFocus />
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
