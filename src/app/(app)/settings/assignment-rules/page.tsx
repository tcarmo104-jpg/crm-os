import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { listAssignmentRules } from '@/repositories/assignment-rules';
import { listTeams } from '@/repositories/teams';
import { describeScope } from '@/lib/assignment-rules';
import { Notice } from '@/components/ui';
import { toggleAssignmentRuleActiveAction } from './actions';

export const metadata: Metadata = { title: 'Distribución de conversaciones' };

export default async function AssignmentRulesPage() {
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'assignment_rules:manage')) return <><header className="page-head"><h1>Distribución de conversaciones</h1></header><Notice kind="error">No tienes acceso a esta sección.</Notice></>;
  const db = await createClient();
  const [rules, teams, flash] = await Promise.all([listAssignmentRules(db, org.orgId), listTeams(db, org.orgId), readFlash()]);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  return (
    <>
      <header className="page-head">
        <h1>Distribución de conversaciones</h1>
        <p className="muted">Reglas que deciden a qué equipo va un contacto nuevo, repartiéndolo por turnos entre sus integrantes. Se evalúan en orden, de menor a mayor prioridad: gana la primera que coincida.</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <div className="flt-bar">
        <Link href="/settings/assignment-rules/new" className="btn btn-primary" style={{ marginLeft: 'auto' }}>+ Nueva regla</Link>
      </div>

      {rules.length === 0 ? (
        <div className="empty-state"><strong>Aún no hay reglas.</strong><p>Sin ninguna regla, los contactos nuevos quedan sin asignar, como siempre. Crea la primera con «+ Nueva regla».</p></div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Prioridad</th><th scope="col">Regla</th><th scope="col">Equipo</th><th scope="col">Aplica a</th><th scope="col">Estado</th><th scope="col"></th></tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td className="small">{r.priority}</td>
                  <td><Link href={`/settings/assignment-rules/${r.id}`}><strong>{r.name}</strong></Link></td>
                  <td className="small">{teamName.get(r.teamId) ?? '—'}</td>
                  <td className="small">{describeScope({ channelKind: r.channelKind, region: r.region, hasHours: Boolean(r.hoursStart) })}</td>
                  <td><span className={`badge ${r.active ? 'badge-ok' : 'badge-neutral'}`}>{r.active ? 'Activa' : 'Pausada'}</span></td>
                  <td>
                    <form action={toggleAssignmentRuleActiveAction}>
                      <input type="hidden" name="ruleId" value={r.id} /><input type="hidden" name="active" value={r.active ? '0' : '1'} />
                      <button type="submit" className="btn btn-ghost btn-sm">{r.active ? 'Pausar' : 'Activar'}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
