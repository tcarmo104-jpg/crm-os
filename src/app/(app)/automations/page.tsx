import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { listRules } from '@/repositories/automations';
import { listMembers } from '@/repositories/members';
import { listSequences } from '@/repositories/sequences';
import { TRIGGER_LABEL, describeAction, describeCondition, type RuleCondition } from '@/lib/automations';
import { Notice } from '@/components/ui';
import { NewRuleModal } from '@/components/automations/RuleModals';
import { setRuleActiveAction } from './actions';

export const metadata: Metadata = { title: 'Automatizaciones' };

export default async function AutomationsPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  if (!can(session, 'automations:read')) return <><header className="page-head"><h1>Automatizaciones</h1></header><Notice kind="error">No tienes acceso a este módulo.</Notice></>;

  const showInactive = sp.estado === 'pausadas';
  const canManage = can(session, 'automations:manage');
  const [all, members, sequences, flash] = await Promise.all([
    listRules(db, org.orgId), listMembers(db, org.orgId),
    canManage ? listSequences(db, org.orgId, { activeOnly: true }) : Promise.resolve([]),
    readFlash(),
  ]);
  const items = all.filter((r) => r.isActive !== showInactive);
  const people: { id: string; name: string }[] = members.filter((m) => m.status === 'active').map((m) => ({ id: m.userId, name: m.fullName ?? m.email ?? 'Sin nombre' }));

  return (
    <>
      <header className="page-head">
        <h1>Automatizaciones</h1>
        <p className="muted">Reglas que se ejecutan solas: «cuando pasa esto, y se cumple esto, entonces haz esto». Se disparan por eventos que el sistema ya registra (nuevos leads, oportunidades ganadas o perdidas, actividades, tareas completadas).</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <div className="flt-bar">
        <div className="view-toggle" role="tablist" aria-label="Estado">
          <Link href="/automations" aria-current={!showInactive ? 'page' : undefined}>Activas</Link>
          <Link href="/automations?estado=pausadas" aria-current={showInactive ? 'page' : undefined}>Pausadas</Link>
        </div>
        {canManage ? <NewRuleModal trigger={<button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }}>+ Nueva automatización</button>} people={people} sequences={sequences.map((s) => ({ id: s.id, name: s.name }))} /> : null}
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <strong>{showInactive ? 'No hay automatizaciones pausadas.' : 'Aún no hay automatizaciones.'}</strong>
          <p>{showInactive ? '' : canManage ? 'Crea la primera con «+ Nueva automatización».' : 'Quien administra las automatizaciones todavía no ha creado ninguna.'}</p>
        </div>
      ) : (
        <div className="stack">
          {items.map((r) => (
            <div key={r.id} className="sequence-card">
              <div className="panel-head">
                <div>
                  <Link href={`/automations/${r.id}`}><strong>{r.name}</strong></Link>
                  <p className="muted small">Cuando: {TRIGGER_LABEL[r.trigger]}</p>
                </div>
                {canManage ? (
                  <form action={setRuleActiveAction}>
                    <input type="hidden" name="ruleId" value={r.id} /><input type="hidden" name="returnTo" value={`/automations${showInactive ? '?estado=pausadas' : ''}`} />
                    <input type="hidden" name="active" value={r.isActive ? '0' : '1'} />
                    <button type="submit" className={r.isActive ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'}>{r.isActive ? 'Pausar' : 'Activar'}</button>
                  </form>
                ) : null}
              </div>
              {r.conditions.length > 0 ? <p className="hint">Si {r.conditions.map((c: RuleCondition) => describeCondition(c)).join(' y ')}</p> : null}
              <p className="hint">{r.actions.map((a) => describeAction(a)).join(' · ')}</p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
