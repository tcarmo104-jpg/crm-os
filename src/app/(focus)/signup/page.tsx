import Link from 'next/link';
import type { Metadata } from 'next';
import { SignupForm } from '@/components/forms';
import { safeNext } from '@/lib/redirect';

export const metadata: Metadata = { title: 'Crear cuenta' };

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  return (
    <div className="stack-lg">
      <div className="stack">
        <h1>Crea tu cuenta</h1>
        {next.startsWith('/invite/') ? (
          <p className="muted">Usa el mismo correo al que llegó la invitación para poder aceptarla.</p>
        ) : null}
      </div>
      <SignupForm next={next} />
      <p className="muted small">
        ¿Ya tienes cuenta? <Link href={`/login?next=${encodeURIComponent(next)}`}>Inicia sesión</Link>
      </p>
    </div>
  );
}
