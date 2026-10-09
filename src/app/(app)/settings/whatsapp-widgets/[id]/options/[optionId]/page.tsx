import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { getWidget } from '@/repositories/widgets';
import { getWidgetOption } from '@/repositories/widget-options';
import { listOptionFields } from '@/repositories/widget-option-fields';
import { listWidgetFields } from '@/repositories/widget-fields';
import { Notice } from '@/components/ui';
import { EditWidgetOptionForm, AddOptionFieldForm } from '@/components/widget-option-field-form';
import { uuidSchema } from '@/services/schemas';
import { updateWidgetOptionAction } from '../../options-actions';
import { addFieldToOptionAction, moveOptionFieldAction, removeFieldFromOptionAction } from './actions';

export const metadata: Metadata = { title: 'Campos de la opción' };

export default async function OptionFieldsPage({ params }: { params: Promise<{ id: string; optionId: string }> }) {
  const { id: widgetId, optionId } = await params;
  if (!uuidSchema.safeParse(widgetId).success || !uuidSchema.safeParse(optionId).success) notFound();
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'settings:manage')) return <><header className="page-head"><h1>Opción</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;
  const db = await createClient();
  const [widget, option, optionFields, allFields, flash] = await Promise.all([
    getWidget(db, widgetId), getWidgetOption(db, optionId), listOptionFields(db, optionId), listWidgetFields(db, org.orgId), readFlash(),
  ]);
  if (!widget || !option || option.widgetId !== widgetId) notFound();
  const usedIds = new Set(optionFields.map((f) => f.fieldId));
  const available = allFields.filter((f) => f.active && !usedIds.has(f.id));

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href={`/settings/whatsapp-widgets/${widgetId}`}>← {widget.name}</Link></p>
        <h1>{option.icon ? `${option.icon} ` : ''}{option.label}</h1>
        <p className="muted">Preguntas ADICIONALES para cuando el visitante elige esta opción — se suman a los «Campos del formulario» del widget, nunca los reemplazan.</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <section className="panel" aria-labelledby="opt-edit-title">
        <div className="panel-head"><h2 id="opt-edit-title">Esta opción</h2></div>
        <EditWidgetOptionForm widgetId={widgetId} optionId={optionId} initial={option} action={updateWidgetOptionAction} />
      </section>

      <section className="panel" aria-labelledby="opt-fields-title">
        <div className="panel-head"><h2 id="opt-fields-title">Preguntas adicionales de esta opción</h2></div>
        {optionFields.length === 0 ? (
          <p className="muted">Todavía no agregaste ninguna — el visitante solo responde los «Campos del formulario» generales del widget.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Campo</th><th scope="col">Obligatorio</th><th scope="col"><span className="sr-only">Acciones</span></th></tr></thead>
              <tbody>
                {optionFields.map((f, idx) => (
                  <tr key={f.fieldId}>
                    <td>{f.labelOverride ?? f.catalogLabel} <span className="small muted">({f.key})</span></td>
                    <td>{f.required ? 'Sí' : 'No'}</td>
                    <td className="cell-actions">
                      <form action={moveOptionFieldAction}>
                        <input type="hidden" name="widgetId" value={widgetId} /><input type="hidden" name="optionId" value={optionId} />
                        <input type="hidden" name="fieldId" value={f.fieldId} /><input type="hidden" name="dir" value="up" />
                        <button className="btn btn-ghost btn-sm" type="submit" disabled={idx === 0} aria-label="Subir">↑</button>
                      </form>
                      <form action={moveOptionFieldAction}>
                        <input type="hidden" name="widgetId" value={widgetId} /><input type="hidden" name="optionId" value={optionId} />
                        <input type="hidden" name="fieldId" value={f.fieldId} /><input type="hidden" name="dir" value="down" />
                        <button className="btn btn-ghost btn-sm" type="submit" disabled={idx === optionFields.length - 1} aria-label="Bajar">↓</button>
                      </form>
                      <form action={removeFieldFromOptionAction}>
                        <input type="hidden" name="widgetId" value={widgetId} /><input type="hidden" name="optionId" value={optionId} />
                        <input type="hidden" name="fieldId" value={f.fieldId} />
                        <button className="btn btn-ghost btn-sm" type="submit">Quitar</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="opt-add-title">
        <div className="panel-head"><h2 id="opt-add-title">Agregar campo</h2></div>
        <AddOptionFieldForm widgetId={widgetId} optionId={optionId} available={available} action={addFieldToOptionAction} />
      </section>
    </>
  );
}
