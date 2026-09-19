/**
 * Devuelve una ruta interna segura para redirecciones (?next=...).
 * Evita "open redirect": solo rutas relativas al mismo sitio.
 */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next) return fallback;
  if (!next.startsWith('/')) return fallback;
  if (next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (/[\r\n]/.test(next)) return fallback;
  return next;
}
