import type { Metadata } from 'next';
import { ResetForm } from '@/components/forms';

export const metadata: Metadata = { title: 'Nueva contraseña' };

export default function ResetPage() {
  return (
    <div className="stack-lg">
      <h1>Crea una contraseña nueva</h1>
      <ResetForm />
    </div>
  );
}
