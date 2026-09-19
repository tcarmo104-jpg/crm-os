import Link from 'next/link';
import type { Metadata } from 'next';
import { ForgotForm } from '@/components/forms';

export const metadata: Metadata = { title: 'Recuperar contraseña' };

export default function ForgotPage() {
  return (
    <div className="stack-lg">
      <div className="stack">
        <h1>Recupera tu contraseña</h1>
        <p className="muted">Escribe tu correo y te enviamos un enlace para crear una contraseña nueva.</p>
      </div>
      <ForgotForm />
      <p className="muted small"><Link href="/login">Volver a iniciar sesión</Link></p>
    </div>
  );
}
