import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { readFlash } from '@/lib/flash';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listChannels } from '@/repositories/inbox';
import { Logo } from '@/components/connections/parts';
import { Notice, SubmitButton } from '@/components/ui';
import { peekMetaSession } from '@/server/connections';
import { createAdminClient } from '@/server/supabase-admin';
import { connectMetaSelectionAction } from '../../actions';
import '../../connections.css';

export const metadata: Metadata = { title: 'Elegir páginas de Meta' };

/** Paso 3 de la conexión con Meta: el administrador elige qué páginas (y cuentas de Instagram) conectar. Los tokens nunca llegan aquí. */
export default async function SelectMetaPage({ searchParams }: { searchParams: Promise<{ s?: string }> }) {
  const { s } = await searchParams;
  const session = (await getSession())!;
  if (!can(session, 'settings:manage')) redirect('/inbox');
  const org = session.active!;
  const sess = s && /^[0-9a-f-]{36}$/i.test(s) ? await peekMetaSession(createAdminClient(), s, org.orgId, session.user.id) : null;
  const [channels, flash] = await Promise.all([listChannels(await createClient(), org.orgId), readFlash()]);
  const healthy = new Set(channels.filter((c) => c.connectionStatus === 'connected').map((c) => `${c.kind}:${c.externalId}`));
  const known = new Set(channels.filter((c) => c.connectionStatus !== 'disconnected').map((c) => `${c.kind}:${c.externalId}`));
  const tag = (k: string) => (healthy.has(k) ? <em> · ya conectada</em> : known.has(k) ? <em> · requiere autorización: se reautoriza</em> : null);

  return (
    <div className="cx">
      <nav aria-label="Ruta"><Link href="/settings/connections" className="cx-back">← Conexiones</Link></nav>
      <header className="cx-head">
        <div>
          <h1>Elige qué conectar</h1>
          <p className="cx-muted">Estas son las páginas de Facebook que administras y las cuentas de Instagram profesional asociadas. Conecta solo las que quieras que lleguen al Inbox.</p>
        </div>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}
      {!sess ? (
        <section className="cx-panel"><p>La autorización venció o ya se usó. Vuelve a empezar.</p><a className="cx-btn cx-btn--primary" href="/api/connections/meta/start">Conectar con Meta</a></section>
      ) : (
        <form action={connectMetaSelectionAction} className="cx-panel">
          <input type="hidden" name="sid" value={s} />
          <ul className="cx-pages">
            {sess.pages.map((p) => (
              <li key={p.id} className="cx-page">
                <div className="cx-page-name"><strong>{p.name}</strong><span className="cx-muted">Página · ID {p.id}</span></div>
                <label className="cx-check"><Logo provider="facebook" size={22} /><input type="checkbox" name={`fb:${p.id}`} defaultChecked={!healthy.has(`facebook:${p.id}`)} /> Messenger{tag(`facebook:${p.id}`)}</label>
                {p.ig ? (
                  <label className="cx-check"><Logo provider="instagram" size={22} /><input type="checkbox" name={`ig:${p.id}`} defaultChecked={!healthy.has(`instagram:${p.ig.id}`)} /> Instagram {p.ig.username ? `@${p.ig.username}` : p.ig.name}{tag(`instagram:${p.ig.id}`)}</label>
                ) : <p className="cx-hint">Esta página no tiene una cuenta de Instagram profesional asociada.</p>}
              </li>
            ))}
          </ul>
          <p className="cx-hint">Al conectar, el CRM suscribe tu app de Meta a los mensajes de cada página y comprueba que todo responda.</p>
          <div className="cx-actions"><SubmitButton className="cx-btn cx-btn--primary" pendingLabel="Conectando y verificando…">Conectar lo elegido</SubmitButton><Link className="cx-btn cx-btn--ghost" href="/settings/connections">Cancelar</Link></div>
        </form>
      )}
    </div>
  );
}
