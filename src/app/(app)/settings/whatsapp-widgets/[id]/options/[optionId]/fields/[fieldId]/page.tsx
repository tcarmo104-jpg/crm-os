import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { getWidget } from '@/repositories/widgets';
import { getWidgetOption } from '@/repositories/widget-options';
import { listOptionFields } from '@/repositories/widget-option-fields';
import { Notice } from '@/components/ui';
import { EditOptionFieldForm } from '@/components/widget-option-field-form';
import { uuidSchema } from '@/services/schemas';
import { updateOptionFieldAction } from '../../actions';

export const metadata: Metadata = { title: 'Editar campo de la opción' };

export default async function EditOptionFieldPage({ params }: { params: Promise<{ id: string; optionId: string; fieldId: string }> }) {
  const { id: widgetId, optionId, fieldId } = await params;
  if (!uuidSchema.safeParse(widgetId).success || !uuidSchema.safeParse(optionId).success || !uuidSchema.safeParse(fieldId).success) notFound();
  const session = (await getSession())!;
  if (!can(session, 'settings:manage')) return <><header className="page-head"><h1>Campo</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;
  const db = await createClient();
  const [widget, option, optionFields, flash] = await Promise.all([
    getWidget(db, widgetId), getWidgetOption(db, optionId), listOptionFields(db, optionId), readFlash(),
  ]);
  if (!widget || !option || option.widgetId !== widgetId) notFound();
  const field = optionFields.find((f) => f.fieldId === fieldId);
  if (!field) notFound();

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href={`/settings/whatsapp-widgets/${widgetId}/options/${optionId}`}>← {option.icon ? `${option.icon} ` : ''}{option.label}</Link></p>
        <h1>{field.labelOverride ?? field.catalogLabel}</h1>
        <p className="muted">Campo del catálogo: {field.catalogLabel} (<code>{field.key}</code>)</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <section className="panel">
        <EditOptionFieldForm widgetId={widgetId} optionId={optionId} field={field} action={updateOptionFieldAction} />
      </section>
    </>
  );
}
