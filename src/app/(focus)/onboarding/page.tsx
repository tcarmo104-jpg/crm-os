import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { OnboardingForm } from '@/components/forms';
import { getSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Crear organización' };

export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  return (
    <div className="stack-lg">
      <div className="stack">
        <h1>Crea tu organización</h1>
        <p className="muted">
          Es el espacio de trabajo de tu empresa: sus clientes, equipos y ventas viven aquí, aislados de cualquier otra
          organización. Si te invitaron a una, abre el enlace de la invitación en lugar de crear una nueva.
        </p>
      </div>
      <OnboardingForm />
    </div>
  );
}
