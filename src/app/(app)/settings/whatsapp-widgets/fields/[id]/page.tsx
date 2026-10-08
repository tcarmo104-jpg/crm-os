import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { getWidgetField } from '@/repositories/widget-fields';
import { WIDGET_FIELD_TYPE_LABELS } from '@/lib/widget-fields';
import { Notice } from '@/components/ui';
import { EditWidgetFieldForm } from '@/components/widget-field-form-edit';
import { uuidSchema } from '@/services/schemas';
import { updateWidgetFieldAction } from '../actions';

export const metadata: Metadata = { title: 'Editar campo del widget' };

export default async function EditWidgetFieldPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const session = (await getSession())!;
  if (!can(session, 'settings:manage')) return <><header className="page-head"><h1>Campo</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;
  const [field, flash] = await Promise.all([getWidgetField(await createClient(), id), readFlash()]);
  if (!field) notFound();

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href="/settings/whatsapp-widgets/fields">← Campos del widget</Link></p>
        <h1>{field.label}</h1>
        <p className="muted">Tipo: {WIDGET_FIELD_TYPE_LABELS[field.fieldType]} · Clave: <code>{field.key}</code> (no se puede cambiar)</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <section className="panel">
        <EditWidgetFieldForm field={field} action={updateWidgetFieldAction} />
      </section>
    </>
  );
}
