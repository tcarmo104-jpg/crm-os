import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listMembers } from '@/repositories/members';
import { listTeams } from '@/repositories/teams';
import { listLeadChannels } from '@/repositories/leads';
import { Notice } from '@/components/ui';
import { AnalyticsFilters, AnalyticsShell, AnalyticsTabs } from '@/components/analytics-shell';

export const metadata: Metadata = { title: 'Analítica' };

/** Analítica en una sola pantalla: Resumen, Embudo, Desempeño, Reportes y Widget de WhatsApp. Este layout NO se
 * vuelve a ejecutar al cambiar de pestaña ni de filtro (solo la página de la pestaña), así que las listas de
 * personas, equipos y canales se cargan una vez. Mismo permiso que tenían las 5 páginas por separado. */
export default async function AnalyticsLayout({ children }: { children: ReactNode }) {
  const session = (await getSession())!;
  const org = session.active!;
  const head = (
    <header className="page-head">
      <h1>Analítica</h1>
      <p className="muted">La foto de toda la organización (o de tu equipo, según tu rol): ventas, embudo, desempeño y de dónde llegan tus clientes.</p>
    </header>
  );
  if (!can(session, 'reports:read')) return <>{head}<Notice kind="error">No tienes acceso a este módulo.</Notice></>;

  const db = await createClient();
  const [members, teams, channels] = await Promise.all([listMembers(db, org.orgId), listTeams(db, org.orgId), listLeadChannels(db, org.orgId)]);
  const people = members.filter((m) => m.status === 'active').map((m) => ({ value: m.userId, label: m.fullName || m.email || 'Sin nombre' }));

  return (
    <div className="an-shell">
      {head}
      <Suspense>
        <AnalyticsShell tabs={<AnalyticsTabs />} filters={<AnalyticsFilters people={people} teams={teams.map((t) => ({ value: t.id, label: t.name }))} channels={channels} />}>
          {children}
        </AnalyticsShell>
      </Suspense>
    </div>
  );
}
