'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { siteUrl } from '@/lib/env';
import { safeNext } from '@/lib/redirect';
import type { ActionState } from '@/lib/action-state';
import { firstIssue, loginSchema, signupSchema } from '@/services/schemas';
import { z } from 'zod';

const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');

export async function login(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = loginSchema.safeParse({ email: str(formData.get('email')), password: str(formData.get('password')) });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const db = await createClient();
  const { error } = await db.auth.signInWithPassword(parsed.data);
  if (error) {
    if (error.message.toLowerCase().includes('not confirmed')) {
      return { ok: false, error: 'Confirma tu correo desde el mensaje que te enviamos y vuelve a iniciar sesión.' };
    }
    return { ok: false, error: 'Correo o contraseña incorrectos.' };
  }
  redirect(safeNext(str(formData.get('next'))));
}

export async function signup(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signupSchema.safeParse({
    fullName: str(formData.get('fullName')),
    email: str(formData.get('email')),
    password: str(formData.get('password')),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const next = safeNext(str(formData.get('next')));
  const db = await createClient();
  const { data, error } = await db.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });
  if (error) {
    if (error.message.toLowerCase().includes('registered')) {
      return { ok: false, error: 'Ese correo ya tiene una cuenta. Inicia sesión.' };
    }
    return { ok: false, error: 'No pudimos crear la cuenta. Revisa los datos e inténtalo de nuevo.' };
  }
  if (data.session) redirect(next); // la confirmación por correo está desactivada
  return {
    ok: true,
    message: 'Te enviamos un correo para confirmar tu cuenta. Ábrelo y sigue el enlace para continuar.',
  };
}

export async function forgotPassword(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z.string().trim().toLowerCase().email('Ingresa un correo válido.').safeParse(str(formData.get('email')));
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const db = await createClient();
  await db.auth.resetPasswordForEmail(parsed.data, {
    redirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent('/reset-password')}`,
  });
  // Misma respuesta exista o no la cuenta: no revela qué correos están registrados.
  return { ok: true, message: 'Si el correo tiene una cuenta, te enviamos un enlace para crear una contraseña nueva.' };
}

export async function resetPassword(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z.string().min(10, 'La contraseña debe tener al menos 10 caracteres.').max(128).safeParse(str(formData.get('password')));
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const db = await createClient();
  const { error } = await db.auth.updateUser({ password: parsed.data });
  if (error) return { ok: false, error: 'No pudimos cambiar la contraseña. Solicita un enlace nuevo.' };
  redirect('/');
}

export async function logout() {
  const db = await createClient();
  await db.auth.signOut();
  redirect('/login');
}
