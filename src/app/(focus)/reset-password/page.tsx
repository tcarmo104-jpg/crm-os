import type { Metadata } from 'next';
import { ResetForm } from '@/components/forms';

export const metadata: Metadata = { title: 'Nueva contraseña' };

export default function ResetPage() {
  return (
    <div className="stack-lg">
      <div className="stack">
        <h1>Crea una contraseña nueva</h1>
        <p className="muted">Elige una contraseña de al menos 10 caracteres para volver a entrar a tu cuenta.</p>
      </div>
      <ResetForm />
    </div>
  );
}
