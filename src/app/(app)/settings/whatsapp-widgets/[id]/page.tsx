import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { getWidget } from '@/repositories/widgets';
import { listChannels } from '@/repositories/inbox';
import { serverOrigin } from '@/server/origin';
import { ConfirmButton, Notice } from '@/components/ui';
import { WidgetForm } from '@/components/widget-form';
import { InstallCode } from '@/components/install-code';
import { uuidSchema } from '@/services/schemas';
import { deleteWidgetAction, updateWidgetAction } from '../actions';

export const metadata: Metadata = { title: 'Editar widget' };

export default async function EditWidgetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'settings:manage')) return <><header className="page-head"><h1>Widget</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;
  const db = await createClient();
  const [widget, allChannels, flash, origin] = await Promise.all([getWidget(db, id), listChannels(db, org.orgId), readFlash(), serverOrigin()]);
  if (!widget) notFound();
  const channels = allChannels.filter((c) => c.kind === 'whatsapp' && c.connectionStatus === 'connected');
  const snippet = `<script src="${origin}/widget/whatsapp.js" data-widget-id="${widget.id}" async></script>`;

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href="/settings/whatsapp-widgets">← Widgets de WhatsApp</Link></p>
        <h1>{widget.name}</h1>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <section className="panel" aria-labelledby="install-title">
        <div className="panel-head"><h2 id="install-title">Código de instalación</h2></div>
        <p className="muted">Pega esto justo antes de <code>&lt;/body&gt;</code> en tu sitio web. No necesitas tocarlo de nuevo si cambias la configuración de abajo — se actualiza solo.</p>
        <InstallCode code={snippet} />
      </section>

      <form action={deleteWidgetAction}>
        <input type="hidden" name="widgetId" value={widget.id} />
        <ConfirmButton message="¿Eliminar este widget? El código instalado en tu web dejará de funcionar de inmediato." className="btn btn-secondary btn-sm">Eliminar widget</ConfirmButton>
      </form>

      <section className="panel">
        <WidgetForm mode="edit" widgetId={widget.id} initial={widget} channels={channels} action={updateWidgetAction} />
      </section>
    </>
  );
}
