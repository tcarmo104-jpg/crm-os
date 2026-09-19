import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { publicEnv } from '@/lib/env';

const PUBLIC_PREFIXES = ['/login', '/signup', '/forgot-password', '/auth', '/api/health', '/api/cron'];

function isPublic(path: string) {
  return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

/** Rutas que se autentican con llave de API (no con sesión): no consultan Supabase Auth. */
const API_KEY_PREFIXES = ['/api/v1'];

/** Refresca la sesión en cada request y protege las rutas privadas. */
export async function updateSession(request: NextRequest) {
  const p = request.nextUrl.pathname;
  if (API_KEY_PREFIXES.some((x) => p === x || p.startsWith(x + '/'))) return NextResponse.next({ request });

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
