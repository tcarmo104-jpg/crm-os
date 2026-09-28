import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { Notice } from '@/components/ui';
import { GeneralSettingsForm } from '@/components/settings-forms';
import { LOCALE_OPTIONS, TIMEZONE_OPTIONS } from '@/lib/org-settings';

export const metadata: Metadata = { title: 'Configuración general' };

export default async function GeneralSettingsPage() {
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'settings:manage')) return <><header className="page-head"><h1>Configuración general</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;
  const db = await createClient();
  const { data: orgRow } = await db.from('organizations').select('currency').eq('id', org.orgId).single();

  return (
    <>
      <header className="page-head">
        <h1>Configuración general</h1>
        <p className="muted">Nombre, zona horaria, idioma y moneda de {org.orgName}. Afecta cómo se muestran fechas y montos en todo el CRM.</p>
      </header>
      <section className="panel">
        <GeneralSettingsForm defaultValues={{ name: org.orgName, timezone: org.orgTimezone, locale: org.orgLocale, currency: orgRow?.currency ?? 'COP' }} timezones={TIMEZONE_OPTIONS} locales={LOCALE_OPTIONS} />
      </section>
    </>
  );
}
