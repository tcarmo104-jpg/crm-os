import 'server-only';
import { cookies } from 'next/headers';

export interface Flash { kind: 'error' | 'ok'; message: string }
const NAME = 'crm_flash';

/** Mensaje de una sola visita (cookie de 10 s) para acciones que terminan en redirect. */
export async function setFlash(flash: Flash) {
  (await cookies()).set(NAME, JSON.stringify(flash), {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: 10, secure: process.env.NODE_ENV === 'production',
  });
}

export async function readFlash(): Promise<Flash | null> {
  const raw = (await cookies()).get(NAME)?.value;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Flash>;
    if ((v.kind === 'error' || v.kind === 'ok') && typeof v.message === 'string') {
      return { kind: v.kind, message: v.message.slice(0, 300) };
    }
  } catch { /* cookie corrupta: se ignora */ }
  return null;
}
