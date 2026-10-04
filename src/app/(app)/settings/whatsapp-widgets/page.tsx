import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { listWidgets } from '@/repositories/widgets';
import { listChannels } from '@/repositories/inbox';
import { Notice } from '@/components/ui';
import { toggleWidgetActiveAction } from './actions';

export const metadata: Metadata = { title: 'Widgets de WhatsApp' };

export default async function WhatsappWidgetsPage() {
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'settings:manage')) return <><header className="page-head"><h1>Widgets de WhatsApp</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;
  const db = await createClient();
  const [widgets, channels, flash] = await Promise.all([listWidgets(db, org.orgId), listChannels(db, org.orgId), readFlash()]);
  const channelName = new Map(channels.map((c) => [c.id, c.name]));

  return (
    <>
      <header className="page-head">
        <h1>Widgets de WhatsApp</h1>
        <p className="muted">Botones de WhatsApp para instalar en tus sitios web. Cuando alguien escribe, cae directo a tu Inbox.</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <div className="flt-bar">
        <Link href="/settings/whatsapp-widgets/new" className="btn btn-primary" style={{ marginLeft: 'auto' }}>+ Nuevo widget</Link>
      </div>

      {widgets.length === 0 ? (
        <div className="empty-state"><strong>Aún no has creado ningún widget.</strong><p>Crea el primero con «+ Nuevo widget».</p></div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Widget</th><th scope="col">WhatsApp</th><th scope="col">Dominios</th><th scope="col">Estado</th><th scope="col">Conversaciones</th><th scope="col"></th></tr></thead>
            <tbody>
              {widgets.map((w) => (
                <tr key={w.id}>
                  <td><Link href={`/settings/whatsapp-widgets/${w.id}`}><strong>{w.name}</strong></Link></td>
                  <td className="small">{channelName.get(w.channelId) ?? '—'}</td>
                  <td className="small">{w.allowedDomains.join(', ')}</td>
                  <td><span className={`badge ${w.active ? 'badge-ok' : 'badge-neutral'}`}>{w.active ? 'Activo' : 'Pausado'}</span></td>
                  <td className="small">{w.conversationsCount}</td>
                  <td>
                    <form action={toggleWidgetActiveAction}>
                      <input type="hidden" name="widgetId" value={w.id} /><input type="hidden" name="active" value={w.active ? '0' : '1'} />
                      <button type="submit" className="btn btn-ghost btn-sm">{w.active ? 'Pausar' : 'Activar'}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
