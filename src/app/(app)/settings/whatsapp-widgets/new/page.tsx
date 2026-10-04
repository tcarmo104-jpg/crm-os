import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listChannels } from '@/repositories/inbox';
import { Notice } from '@/components/ui';
import { WidgetForm } from '@/components/widget-form';
import { createWidgetAction } from '../actions';

export const metadata: Metadata = { title: 'Nuevo widget de WhatsApp' };

export default async function NewWidgetPage() {
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'settings:manage')) return <><header className="page-head"><h1>Nuevo widget</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;
  const db = await createClient();
  const channels = (await listChannels(db, org.orgId)).filter((c) => c.kind === 'whatsapp' && c.connectionStatus === 'connected');

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href="/settings/whatsapp-widgets">← Widgets de WhatsApp</Link></p>
        <h1>Nuevo widget</h1>
      </header>
      <section className="panel">
        <WidgetForm mode="create" channels={channels} action={createWidgetAction} />
      </section>
    </>
  );
}
