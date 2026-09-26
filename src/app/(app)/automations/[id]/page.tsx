import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { getRule, listRuns } from '@/repositories/automations';
import { listMembers } from '@/repositories/members';
import { RUN_STATUS_BADGE, RUN_STATUS_LABEL, TRIGGER_LABEL, describeAction, describeCondition, type RuleCondition } from '@/lib/automations';
import { ConfirmButton, Notice } from '@/components/ui';
import { uuidSchema } from '@/services/schemas';
import { setRuleActiveAction } from '../actions';

export const metadata: Metadata = { title: 'Automatización' };

export default async function AutomationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  if (!can(session, 'automations:read')) notFound();

  const rule = await getRule(db, id);
  if (!rule) notFound();
  const [runs, members, flash] = await Promise.all([listRuns(db, id), listMembers(db, org.orgId), readFlash()]);
  const canManage = can(session, 'automations:manage');
  const back = `/automations/${id}`;
  const creatorName = members.find((m) => m.userId === rule.createdBy)?.fullName ?? members.find((m) => m.userId === rule.createdBy)?.email ?? 'Alguien';
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: org.orgTimezone });

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href="/automations">← Automatizaciones</Link></p>
        <h1>{rule.name} <span className={`badge ${rule.isActive ? 'badge-ok' : 'badge-neutral'}`}>{rule.isActive ? 'Activa' : 'Pausada'}</span></h1>
        <p className="muted">Las acciones se ejecutan con el permiso de {creatorName}, quien creó esta automatización.</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      {canManage ? (
        <form action={setRuleActiveAction}>
          <input type="hidden" name="ruleId" value={rule.id} /><input type="hidden" name="returnTo" value={back} />
          <input type="hidden" name="active" value={rule.isActive ? '0' : '1'} />
          <ConfirmButton message={rule.isActive ? '¿Pausar esta automatización?' : '¿Activar esta automatización?'} className={rule.isActive ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'}>
            {rule.isActive ? 'Pausar' : 'Activar'}
          </ConfirmButton>
        </form>
      ) : null}

      <section className="panel" aria-labelledby="rule-title">
        <div className="panel-head"><h2 id="rule-title">La regla</h2></div>
        <p><strong>Cuándo:</strong> {TRIGGER_LABEL[rule.trigger]}</p>
        {rule.conditions.length > 0 ? <p><strong>Si:</strong> {rule.conditions.map((c: RuleCondition) => describeCondition(c)).join(' y ')}</p> : <p className="muted">Sin condiciones: aplica siempre.</p>}
        <p><strong>Entonces:</strong></p>
        <ul className="id-list">{rule.actions.map((a, i) => <li key={i}><span>{describeAction(a)}</span></li>)}</ul>
      </section>

      <section className="panel" aria-labelledby="runs-title">
        <div className="panel-head"><h2 id="runs-title">Historial ({runs.length})</h2></div>
        {runs.length === 0 ? (
          <p className="muted">Todavía no se ha disparado. Aparecerá aquí la próxima vez que ocurra «{TRIGGER_LABEL[rule.trigger]}».</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Fecha</th><th scope="col">Resultado</th><th scope="col">Detalle</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="small">{fmt.format(new Date(r.ranAt))}</td>
                    <td><span className={`badge ${RUN_STATUS_BADGE[r.status]}`}>{RUN_STATUS_LABEL[r.status]}</span></td>
                    <td className="small">{r.detail ?? '—'}</td>
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
