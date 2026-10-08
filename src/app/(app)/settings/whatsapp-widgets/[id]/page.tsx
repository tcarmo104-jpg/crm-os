import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { getWidget } from '@/repositories/widgets';
import { listWidgetOptions } from '@/repositories/widget-options';
import { listChannels } from '@/repositories/inbox';
import { serverOrigin } from '@/server/origin';
import { ConfirmButton, Notice } from '@/components/ui';
import { WidgetForm } from '@/components/widget-form';
import { WidgetOptionForm } from '@/components/widget-option-form';
import { InstallCode } from '@/components/install-code';
import { uuidSchema } from '@/services/schemas';
import { deleteWidgetAction, updateWidgetAction } from '../actions';
import { moveWidgetOptionAction, setWidgetOptionActiveAction, deleteWidgetOptionAction } from './options-actions';

export const metadata: Metadata = { title: 'Editar widget' };

export default async function EditWidgetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'settings:manage')) return <><header className="page-head"><h1>Widget</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;
  const db = await createClient();
  const [widget, allChannels, options, flash, origin] = await Promise.all([
    getWidget(db, id), listChannels(db, org.orgId), listWidgetOptions(db, id), readFlash(), serverOrigin(),
  ]);
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

      <section className="panel" aria-labelledby="options-title">
        <div className="panel-head">
          <h2 id="options-title">Opciones del widget (intenciones)</h2>
          <Link href="/settings/whatsapp-widgets/fields" className="small">Catálogo de campos →</Link>
        </div>
        <p className="muted">
          El menú que el visitante ve al abrir el widget (💬 Comprar, 💰 Cotizar…). Cada opción puede pedir sus propios
          datos y tener su propio mensaje a WhatsApp. Sin opciones, el widget sigue funcionando con el formulario general de abajo.
        </p>
        {options.length === 0 ? null : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Opción</th><th scope="col"><span className="sr-only">Acciones</span></th></tr></thead>
              <tbody>
                {options.map((o, idx) => (
                  <tr key={o.id}>
                    <td>{o.icon ? `${o.icon} ` : ''}{o.label} {!o.active ? <span className="badge">Desactivada</span> : null}</td>
                    <td className="cell-actions">
                      <Link href={`/settings/whatsapp-widgets/${widget.id}/options/${o.id}`} className="btn btn-ghost btn-sm">Campos →</Link>
                      <form action={moveWidgetOptionAction}>
                        <input type="hidden" name="widgetId" value={widget.id} /><input type="hidden" name="optionId" value={o.id} /><input type="hidden" name="dir" value="up" />
                        <button className="btn btn-ghost btn-sm" type="submit" disabled={idx === 0} aria-label="Subir">↑</button>
                      </form>
                      <form action={moveWidgetOptionAction}>
                        <input type="hidden" name="widgetId" value={widget.id} /><input type="hidden" name="optionId" value={o.id} /><input type="hidden" name="dir" value="down" />
                        <button className="btn btn-ghost btn-sm" type="submit" disabled={idx === options.length - 1} aria-label="Bajar">↓</button>
                      </form>
                      <form action={setWidgetOptionActiveAction}>
                        <input type="hidden" name="widgetId" value={widget.id} /><input type="hidden" name="optionId" value={o.id} /><input type="hidden" name="active" value={o.active ? '0' : '1'} />
                        <button className="btn btn-ghost btn-sm" type="submit">{o.active ? 'Desactivar' : 'Activar'}</button>
                      </form>
                      <form action={deleteWidgetOptionAction}>
                        <input type="hidden" name="widgetId" value={widget.id} /><input type="hidden" name="optionId" value={o.id} />
                        <ConfirmButton message="¿Eliminar esta opción?" className="btn btn-ghost btn-sm">Eliminar</ConfirmButton>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <WidgetOptionForm widgetId={widget.id} />
      </section>

      <section className="panel">
        <WidgetForm mode="edit" widgetId={widget.id} initial={widget} channels={channels} action={updateWidgetAction} />
      </section>
    </>
  );
}
