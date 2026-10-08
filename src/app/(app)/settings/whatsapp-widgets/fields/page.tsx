import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { listWidgetFields } from '@/repositories/widget-fields';
import { WIDGET_FIELD_TYPE_LABELS } from '@/lib/widget-fields';
import { WidgetFieldForm } from '@/components/widget-field-form';
import { ConfirmButton, Notice } from '@/components/ui';
import { setWidgetFieldActiveAction, deleteWidgetFieldAction } from './actions';

export const metadata: Metadata = { title: 'Campos del widget de WhatsApp' };

export default async function WidgetFieldsPage() {
  const session = (await getSession())!;
  const org = session.active!;
  const canManage = can(session, 'settings:manage');
  if (!canManage) return <><header className="page-head"><h1>Campos del widget</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;
  const [fields, flash] = await Promise.all([listWidgetFields(await createClient(), org.orgId), readFlash()]);

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href="/settings/whatsapp-widgets">← Widgets de WhatsApp</Link></p>
        <h1>Campos del widget</h1>
        <p className="muted">
          El catálogo de datos que tus widgets le pueden pedir a un visitante (nombre, producto, presupuesto…). Se comparte
          entre todos tus widgets; luego eliges cuáles usa cada intención, en qué orden y si son obligatorios, desde cada widget.
        </p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <section className="panel" aria-labelledby="new-field">
        <div className="panel-head"><h2 id="new-field">Nuevo campo</h2></div>
        <WidgetFieldForm existingKeys={fields.map((f) => f.key)} />
      </section>

      <section className="panel" aria-labelledby="fields-title">
        <div className="panel-head"><h2 id="fields-title">Campos de la organización</h2></div>
        {fields.length === 0 ? (
          <div className="empty"><p><strong>Aún no hay campos en el catálogo.</strong></p></div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th scope="col">Nombre</th><th scope="col">Tipo</th><th scope="col">Clave</th><th scope="col"><span className="sr-only">Acciones</span></th>
              </tr></thead>
              <tbody>
                {fields.map((f) => (
                  <tr key={f.id}>
                    <td>{f.label} {!f.active ? <span className="badge">Desactivado</span> : null}
                      {f.options.length > 0 ? <div className="small muted">{f.options.join(' · ')}</div> : null}</td>
                    <td>{WIDGET_FIELD_TYPE_LABELS[f.fieldType]}</td>
                    <td><code>{f.key}</code></td>
                    <td className="cell-actions">
                      <Link href={`/settings/whatsapp-widgets/fields/${f.id}`} className="btn btn-ghost btn-sm">Editar</Link>
                      <form action={setWidgetFieldActiveAction}>
                        <input type="hidden" name="fieldId" value={f.id} />
                        <input type="hidden" name="active" value={f.active ? '0' : '1'} />
                        <button className="btn btn-ghost btn-sm" type="submit">{f.active ? 'Desactivar' : 'Activar'}</button>
                      </form>
                      <form action={deleteWidgetFieldAction}>
                        <input type="hidden" name="fieldId" value={f.id} />
                        <ConfirmButton message="¿Eliminar este campo? Se va a quitar también de cualquier intención que lo esté usando." className="btn btn-ghost btn-sm">Eliminar</ConfirmButton>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
