import Link from 'next/link';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { Notice, SubmitButton } from '@/components/ui';
import * as invitations from '@/services/invitations';
import { acceptInvite } from './actions';
import { logout } from '@/app/auth-actions';

export const metadata: Metadata = { title: 'Invitación' };

const STATUS_TEXT: Record<string, string> = {
  accepted: 'Esta invitación ya fue utilizada.',
  revoked: 'Esta invitación fue cancelada. Pide una nueva a tu administrador.',
  expired: 'Esta invitación venció. Pide una nueva a tu administrador.',
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);

  const preview = await invitations.preview(await createClient(), token);
  const flash = await readFlash();

  if (!preview) {
    return (
      <div className="stack-lg">
        <h1>No encontramos esta invitación</h1>
        <p className="muted">Revisa que el enlace esté completo o pide uno nuevo a tu administrador.</p>
        <p><Link className="btn btn-secondary" href="/">Ir al inicio</Link></p>
      </div>
    );
  }

  if (preview.status !== 'pending') {
    return (
      <div className="stack-lg">
        <h1>Invitación no disponible</h1>
        <Notice kind="error">{STATUS_TEXT[preview.status]}</Notice>
        <p><Link className="btn btn-secondary" href="/">Ir al inicio</Link></p>
      </div>
    );
  }

  const wrongAccount = session.user.email.toLowerCase() !== preview.email;

  return (
    <div className="stack-lg">
      <div className="stack">
        <h1>Te invitaron a {preview.orgName}</h1>
        <p className="muted">Entrarás con el rol de {preview.roleName}.</p>
      </div>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}
      {wrongAccount ? (
        <div className="stack">
          <Notice kind="error">
            Esta invitación es para {preview.email}, pero iniciaste sesión como {session.user.email}. Cierra sesión y entra
            con el correo correcto.
          </Notice>
          <form action={logout}><button className="btn btn-secondary" type="submit">Cerrar sesión</button></form>
        </div>
      ) : (
        <form action={acceptInvite} className="stack">
          <input type="hidden" name="token" value={token} />
          <div><SubmitButton pendingLabel="Entrando…">Unirme a {preview.orgName}</SubmitButton></div>
        </form>
      )}
    </div>
  );
}
