/**
 * Dirección pública del CRM. Se DETECTA sola por la petición (así no hace falta una variable en Vercel); una variable explícita con
 * `https://` (NEXT_PUBLIC_SITE_URL) sigue mandando si existe. Lógica pura.
 */
const LOCAL = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|.*\.local$)/i;
const first = (v: string | null | undefined) => (v ?? '').split(',')[0]!.trim();

export const isLocalHost = (host: string) => LOCAL.test(host.split(':')[0]!);
/** ¿Es una dirección pública con https (la que Meta y Google aceptan)? */
export const isPublicHttps = (origin: string | null | undefined) => {
  const m = /^https:\/\/([^/\s:]+)(:\d+)?$/i.exec((origin ?? '').trim());
  return Boolean(m && !isLocalHost(m[1]!));
};

export function pickOrigin(o: { envUrl?: string | null; host?: string | null; proto?: string | null }): string | null {
  const env = (o.envUrl ?? '').trim().replace(/\/+$/, '');
  if (isPublicHttps(env)) return env;                                   // la variable explícita, si es válida, manda
  const host = first(o.host).toLowerCase();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) return null;              // nada de rutas, credenciales ni caracteres raros
  const proto = first(o.proto).toLowerCase();
  return `${isLocalHost(host) ? (proto === 'https' ? 'https' : 'http') : 'https'}://${host}`;
}
