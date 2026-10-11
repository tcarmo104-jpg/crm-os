import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { getWidget } from '@/repositories/widgets';
import { listDefaultFields } from '@/repositories/widget-default-fields';
import { Notice } from '@/components/ui';
import { EditDefaultFieldForm } from '@/components/widget-default-field-form';
import { uuidSchema } from '@/services/schemas';
import { updateDefaultFieldAction } from '../../default-fields-actions';

export const metadata: Metadata = { title: 'Editar campo del formulario' };

export default async function EditDefaultFieldPage({ params }: { params: Promise<{ id: string; fieldId: string }> }) {
  const { id: widgetId, fieldId } = await params;
  if (!uuidSchema.safeParse(widgetId).success || !uuidSchema.safeParse(fieldId).success) notFound();
  const session = (await getSession())!;
  if (!can(session, 'settings:manage')) return <><header className="page-head"><h1>Campo</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;
  const db = await createClient();
  const [widget, defaultFields, flash] = await Promise.all([getWidget(db, widgetId), listDefaultFields(db, widgetId), readFlash()]);
  if (!widget) notFound();
  const field = defaultFields.find((f) => f.fieldId === fieldId);
  if (!field) notFound();

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href={`/settings/whatsapp-widgets/${widgetId}`}>← {widget.name}</Link></p>
        <h1>{field.labelOverride ?? field.catalogLabel}</h1>
        <p className="muted">Campo del catálogo: {field.catalogLabel} (<code>{field.key}</code>)</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <section className="panel">
        <EditDefaultFieldForm widgetId={widgetId} field={field} action={updateDefaultFieldAction} />
      </section>
    </>
  );
}
