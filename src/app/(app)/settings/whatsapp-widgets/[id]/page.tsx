import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { getWidget } from '@/repositories/widgets';
import { listWidgetOptions } from '@/repositories/widget-options';
import { listDefaultFields } from '@/repositories/widget-default-fields';
import { listWidgetFields } from '@/repositories/widget-fields';
import { listChannels } from '@/repositories/inbox';
import { listMembers } from '@/repositories/members';
import { serverOrigin } from '@/server/origin';
import { ConfirmButton, Notice } from '@/components/ui';
import { WidgetForm } from '@/components/widget-form';
import { WidgetOptionForm } from '@/components/widget-option-form';
import { AddDefaultFieldForm } from '@/components/widget-default-field-form';
import { InstallCode } from '@/components/install-code';
import { uuidSchema } from '@/services/schemas';
import { deleteWidgetAction, updateWidgetAction } from '../actions';
import { moveWidgetOptionAction, setWidgetOptionActiveAction, deleteWidgetOptionAction } from './options-actions';
import { addDefaultFieldAction, moveDefaultFieldAction, removeDefaultFieldAction } from './default-fields-actions';

export const metadata: Metadata = { title: 'Editar widget' };

export default async function EditWidgetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'settings:manage')) return <><header className="page-head"><h1>Widget</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;
  const db = await createClient();
  const [widget, allChannels, options, defaultFields, allFields, members, flash, origin] = await Promise.all([
    getWidget(db, id), listChannels(db, org.orgId), listWidgetOptions(db, id), listDefaultFields(db, id), listWidgetFields(db, org.orgId), listMembers(db, org.orgId), readFlash(), serverOrigin(),
  ]);
  if (!widget) notFound();
  const channels = allChannels.filter((c) => c.kind === 'whatsapp' && c.connectionStatus === 'connected');
  const snippet = `<script src="${origin}/widget/whatsapp.js" data-widget-id="${widget.id}" async></script>`;
  const usedDefaultIds = new Set(defaultFields.map((f) => f.fieldId));
  const availableForDefault = allFields.filter((f) => f.active && !usedDefaultIds.has(f.id));

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

      <section className="panel" aria-labelledby="default-fields-title">
        <div className="panel-head">
          <h2 id="default-fields-title">Campos del formulario</h2>
          <Link href="/settings/whatsapp-widgets/fields" className="small">Ver todos los campos que puedes pedir →</Link>
        </div>
        <p className="muted">
          Lo que el visitante SIEMPRE ve y responde antes de escribirte, tenga o no un menú de opciones abajo. Por defecto
          solo pide nombre y WhatsApp — agrega aquí cualquier otro dato que necesites (empresa, producto, ciudad…) y marca
          cuáles son obligatorios.
        </p>
        {defaultFields.length === 0 ? (
          <p className="muted">Todavía no agregaste ningún campo — el visitante solo verá nombre y WhatsApp (los datos mínimos para contactarlo).</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Campo</th><th scope="col">Obligatorio</th><th scope="col"><span className="sr-only">Acciones</span></th></tr></thead>
              <tbody>
                {defaultFields.map((f, idx) => (
                  <tr key={f.fieldId}>
                    <td>{f.labelOverride ?? f.catalogLabel} <span className="small muted">({f.key})</span></td>
                    <td>{f.required ? 'Sí' : 'No'}</td>
                    <td className="cell-actions">
                      <form action={moveDefaultFieldAction}>
                        <input type="hidden" name="widgetId" value={widget.id} /><input type="hidden" name="fieldId" value={f.fieldId} /><input type="hidden" name="dir" value="up" />
                        <button className="btn btn-ghost btn-sm" type="submit" disabled={idx === 0} aria-label="Subir">↑</button>
                      </form>
                      <form action={moveDefaultFieldAction}>
                        <input type="hidden" name="widgetId" value={widget.id} /><input type="hidden" name="fieldId" value={f.fieldId} /><input type="hidden" name="dir" value="down" />
                        <button className="btn btn-ghost btn-sm" type="submit" disabled={idx === defaultFields.length - 1} aria-label="Bajar">↓</button>
                      </form>
                      <form action={removeDefaultFieldAction}>
                        <input type="hidden" name="widgetId" value={widget.id} /><input type="hidden" name="fieldId" value={f.fieldId} />
                        <button className="btn btn-ghost btn-sm" type="submit">Quitar</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <AddDefaultFieldForm widgetId={widget.id} available={availableForDefault} action={addDefaultFieldAction} />
      </section>

      <form action={deleteWidgetAction}>
        <input type="hidden" name="widgetId" value={widget.id} />
        <ConfirmButton message="¿Eliminar este widget? El código instalado en tu web dejará de funcionar de inmediato." className="btn btn-secondary btn-sm">Eliminar widget</ConfirmButton>
      </form>

      <section className="panel" aria-labelledby="options-title">
        <div className="panel-head">
          <h2 id="options-title">Menú de opciones (enrutamiento, opcional)</h2>
        </div>
        <p className="muted">
          Si quieres que el visitante elija primero qué necesita (💬 Comprar, 💰 Cotizar…), créalo aquí. Cada opción puede
          pedir preguntas ADICIONALES propias (se suman a los «Campos del formulario» de arriba, nunca los reemplazan) y
          tener su propio mensaje a WhatsApp. Sin ninguna opción, el widget va directo al formulario de arriba.
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
        <WidgetForm mode="edit" widgetId={widget.id} initial={widget} channels={channels} members={members} action={updateWidgetAction} />
      </section>
    </>
  );
}
