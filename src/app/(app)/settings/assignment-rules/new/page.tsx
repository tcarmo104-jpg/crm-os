import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listTeams } from '@/repositories/teams';
import { listWidgets } from '@/repositories/widgets';
import { Notice } from '@/components/ui';
import { AssignmentRuleForm } from '@/components/assignment-rule-form';
import { createAssignmentRuleAction } from '../actions';

export const metadata: Metadata = { title: 'Nueva regla de distribución' };

export default async function NewAssignmentRulePage() {
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'assignment_rules:manage')) return <><header className="page-head"><h1>Nueva regla</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;
  const db = await createClient();
  const [teams, widgets] = await Promise.all([listTeams(db, org.orgId), listWidgets(db, org.orgId)]);

  if (teams.length === 0) {
    return (
      <>
        <header className="page-head"><p className="small"><Link href="/settings/assignment-rules">← Distribución de conversaciones</Link></p><h1>Nueva regla</h1></header>
        <Notice kind="error">Todavía no tienes ningún equipo creado. Crea uno en Configuración → Equipos primero.</Notice>
      </>
    );
  }

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href="/settings/assignment-rules">← Distribución de conversaciones</Link></p>
        <h1>Nueva regla</h1>
      </header>
      <section className="panel">
        <AssignmentRuleForm mode="create" teams={teams} widgets={widgets.map((w) => ({ id: w.id, name: w.name }))} action={createAssignmentRuleAction} />
      </section>
    </>
  );
}
