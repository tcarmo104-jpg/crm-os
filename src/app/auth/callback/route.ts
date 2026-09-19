import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { safeNext } from '@/lib/redirect';

export const dynamic = 'force-dynamic';

/** Destino de los enlaces de correo (confirmación de cuenta y recuperación de contraseña). */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const next = safeNext(searchParams.get('next'));

  if (code) {
    const db = await createClient();
    const { error } = await db.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }
  return NextResponse.redirect(`${origin}/login?error=callback`);
}
