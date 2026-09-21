import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { publicEnv } from '@/lib/env';

const PUBLIC_PREFIXES = ['/login', '/signup', '/forgot-password', '/auth', '/api/health', '/api/cron', '/privacidad', '/eliminacion-de-datos'];

function isPublic(path: string) {
  return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

/**
 * Rutas que se autentican por sí mismas (llave de API, o la firma de Meta en los webhooks): NO usan sesión de
 * usuario ni consultan Supabase Auth. Si un webhook no figura aquí, el servidor de Meta (que no tiene sesión)
 * recibe una redirección al login y jamás llega el saludo ni ningún mensaje.
 */
const SELF_AUTH_PREFIXES = ['/api/v1', '/api/webhooks'];
export function isSelfAuthenticated(path: string) {
  return SELF_AUTH_PREFIXES.some((x) => path === x || path.startsWith(x + '/'));
}

/** Refresca la sesión en cada request y protege las rutas privadas. */
export async function updateSession(request: NextRequest) {
  const p = request.nextUrl.pathname;
  if (isSelfAuthenticated(p)) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const { url, anonKey } = publicEnv();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });

  // getUser() valida el token contra Supabase Auth (getSession() no lo hace).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const redirectTo = (pathname: string, search = '') => {
    const target = request.nextUrl.clone();
    target.pathname = pathname;
    target.search = search;
    const res = NextResponse.redirect(target);
    for (const c of response.cookies.getAll()) res.cookies.set(c);
    return res;
  };

  if (!user && !isPublic(path)) {
    const next = path + request.nextUrl.search;
    return redirectTo('/login', `?next=${encodeURIComponent(next)}`);
  }
  if (user && (path === '/login' || path === '/signup')) {
    return redirectTo('/');
  }
  return response;
}
