import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { getAssignmentRule } from '@/repositories/assignment-rules';
import { listTeams } from '@/repositories/teams';
import { listWidgets } from '@/repositories/widgets';
import { Notice, ConfirmButton } from '@/components/ui';
import { AssignmentRuleForm } from '@/components/assignment-rule-form';
import { uuidSchema } from '@/services/schemas';
import { deleteAssignmentRuleAction, updateAssignmentRuleAction } from '../actions';

export const metadata: Metadata = { title: 'Editar regla de distribución' };

export default async function EditAssignmentRulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'assignment_rules:manage')) return <><header className="page-head"><h1>Regla</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;
  const db = await createClient();
  const [rule, teams, widgets, flash] = await Promise.all([getAssignmentRule(db, id), listTeams(db, org.orgId), listWidgets(db, org.orgId), readFlash()]);
  if (!rule) notFound();

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href="/settings/assignment-rules">← Distribución de conversaciones</Link></p>
        <h1>{rule.name}</h1>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <form action={deleteAssignmentRuleAction}>
        <input type="hidden" name="ruleId" value={rule.id} />
        <ConfirmButton message="¿Eliminar esta regla? Deja de repartir conversaciones de inmediato." className="btn btn-secondary btn-sm">Eliminar regla</ConfirmButton>
      </form>

      <section className="panel">
        <AssignmentRuleForm mode="edit" ruleId={rule.id} initial={rule} teams={teams} widgets={widgets.map((w) => ({ id: w.id, name: w.name }))} action={updateAssignmentRuleAction} />
      </section>
    </>
  );
}
