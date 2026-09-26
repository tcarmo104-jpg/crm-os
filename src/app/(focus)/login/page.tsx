import Link from 'next/link';
import type { Metadata } from 'next';
import { LoginForm } from '@/components/forms';
import { Notice } from '@/components/ui';
import { safeNext } from '@/lib/redirect';

export const metadata: Metadata = { title: 'Iniciar sesión' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const fromInvite = next.startsWith('/invite/');
  return (
    <div className="stack-lg">
      <div className="stack">
        <h1>Bienvenido de nuevo</h1>
        <p className="muted">
          {fromInvite
            ? 'Entra con el correo al que llegó la invitación, o crea una cuenta con ese mismo correo.'
            : 'Ingresa tus datos para entrar a tu cuenta.'}
        </p>
      </div>
      {sp.error === 'callback' ? (
        <Notice kind="error">El enlace del correo no es válido o ya venció. Inicia sesión, o solicita uno nuevo.</Notice>
      ) : null}
      <LoginForm next={next} />
      <p className="muted small">
        ¿Aún no tienes cuenta? <Link href={`/signup?next=${encodeURIComponent(next)}`}>Crear cuenta</Link>
      </p>
    </div>
  );
}
