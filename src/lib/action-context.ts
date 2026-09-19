import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/session';
import { UserFacingError } from '@/lib/errors';
import { safeNext } from '@/lib/redirect';

/** Contexto de una server action: la organización SIEMPRE sale de la sesión validada, nunca del formulario. */
export async function actionContext() {
  const s = await getSession();
  if (!s?.active) throw new UserFacingError('Tu sesión venció. Inicia sesión de nuevo.');
  return { org: s.active, session: s, db: await createClient() };
}

export const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');

/** Ruta de retorno del formulario (solo rutas internas). */
export const returnTo = (fd: FormData, fallback: string) => safeNext(str(fd.get('returnTo')), fallback);
