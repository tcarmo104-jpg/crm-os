import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { forecast, orderedStages } from '@/lib/pipeline';
import { formatMoney } from '@/lib/money';
import type { OpportunityRow, StageRow } from '@/lib/types';
import { listPipelines } from '@/repositories/pipelines';
import { listOpportunities } from '@/repositories/opportunities';
import { getCustomersByIds } from '@/repositories/customers';
import { listMembers } from '@/repositories/members';
import { Notice } from '@/components/ui';
import { moveOpportunityAction } from './actions';

export const metadata: Metadata = { title: 'Oportunidades' };

type SP = Promise<{ pipeline?: string; view?: string }>;

export default async function OpportunitiesPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  const view = sp.view === 'won' || sp.view === 'lost' ? sp.view : 'board';

  const [pipelines, flash, members] = await Promise.all([listPipelines(db, org.orgId), readFlash(), listMembers(db, org.orgId)]);
  const pipeline = pipelines.find((p) => p.id === sp.pipeline) ?? pipelines.find((p) => p.isDefault) ?? pipelines[0];
  const canRead = can(session, 'opportunities:read');
  const opps = pipeline && canRead
    ? await listOpportunities(db, { orgId: org.orgId, pipelineId: pipeline.id, status: view === 'board' ? 'open' : view, limit: view === 'board' ? 500 : 100 })
    : [];
  const customers = await getCustomersByIds(db, [...new Set(opps.map((o) => o.customerId))]);
  const cName = new Map(customers.map((c) => [c.id, c.fullName]));
  const owners = new Map(members.map((m) => [m.userId, m.fullName ?? m.email ?? 'Sin nombre']));

  const stages = pipeline ? orderedStages(pipeline.stages) : [];
  const openStages = stages.filter((s) => s.kind === 'open');
  const f = forecast(opps, openStages);
  const money = (n: number, cur?: string | null) => formatMoney(n, cur ?? 'COP', org.orgLocale);
  const currency = opps[0]?.currency ?? null;
  const canMove = can(session, 'opportunities:update');
  const back = `/opportunities?${new URLSearchParams({ ...(pipeline ? { pipeline: pipeline.id } : {}), ...(view !== 'board' ? { view } : {}) }).toString()}`;
  const fmtDate = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeZone: org.orgTimezone });

  const Card = ({ o }: { o: OpportunityRow }) => (
    <article className="opp-card" aria-label={o.title}>
      <Link className="title" href={`/opportunities/${o.id}`}>{o.title}</Link>
      <span className="meta">{cName.get(o.customerId) ?? 'Cliente no disponible'}</span>
      <span><strong>{money(o.amount, o.currency)}</strong>{o.expectedCloseDate ? <span className="meta"> · cierre {fmtDate.format(new Date(`${o.expectedCloseDate}T12:00:00`))}</span> : null}</span>
      <span className="meta">{o.ownerId ? (owners.get(o.ownerId) ?? '—') : 'Sin asignar'}</span>
      {o.status === 'lost' && o.lostReason ? <span className="meta">Motivo: {o.lostReason}</span> : null}
      {canMove ? (
        <details>
          <summary>Mover</summary>
          <form action={moveOpportunityAction}>
            <input type="hidden" name="opportunityId" value={o.id} />
            <input type="hidden" name="returnTo" value={back} />
            <label className="sr-only" htmlFor={`st-${o.id}`}>Etapa</label>
            <select id={`st-${o.id}`} name="stageId" className="select select-sm" defaultValue="">
              <option value="" disabled>Elegir etapa…</option>
              <StageOptions stages={stages} current={o.stageId} />
            </select>
            <label className="sr-only" htmlFor={`rs-${o.id}`}>Motivo si se pierde</label>
            <input id={`rs-${o.id}`} name="reason" className="input" maxLength={500} placeholder="Motivo (obligatorio si la pierdes)" />
            <button className="btn btn-secondary btn-sm" type="submit">Mover</button>
          </form>
        </details>
      ) : null}
    </article>
  );

  return (
    <>
      <header className="page-head">
        <h1>Oportunidades</h1>
        <p className="muted">Lo que estás vendiendo, etapa por etapa. Cada cambio queda registrado con quién, cuándo y por qué.</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <section className="panel" aria-label="Filtros">
        <div className="inline-form" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <nav className="tabs" aria-label="Vista">
            {([['board', 'Abiertas'], ['won', 'Ganadas'], ['lost', 'Perdidas']] as const).map(([v, l]) => (
              <Link key={v} href={`/opportunities?${new URLSearchParams({ ...(pipeline ? { pipeline: pipeline.id } : {}), ...(v !== 'board' ? { view: v } : {}) })}`}
                aria-current={view === v ? 'page' : undefined}>{l}</Link>
            ))}
          </nav>
          <div className="inline-form">
            {pipelines.length > 1 ? (
              <form method="get" className="inline-form">
                {view !== 'board' ? <input type="hidden" name="view" value={view} /> : null}
                <label className="sr-only" htmlFor="pipeline">Pipeline</label>
                <select id="pipeline" name="pipeline" className="select select-sm" defaultValue={pipeline?.id}>
                  {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button className="btn btn-secondary btn-sm" type="submit">Ver</button>
              </form>
            ) : null}
            {can(session, 'opportunities:create') ? <Link className="btn btn-primary" href="/opportunities/new">Nueva oportunidad</Link> : null}
          </div>
        </div>
      </section>

      {view === 'board' ? (
        <>
          <div className="stats" role="group" aria-label="Resumen del embudo">
            <div className="stat"><span className="n">{f.open}</span><span className="l">Abiertas</span></div>
            <div className="stat"><span className="n">{money(f.amount, currency)}</span><span className="l">Valor total</span></div>
            <div className="stat"><span className="n">{money(f.weighted, currency)}</span><span className="l">Ponderado por probabilidad</span></div>
          </div>
          {openStages.length === 0 ? (
            <section className="panel"><p className="muted">Este pipeline no tiene etapas abiertas.</p></section>
          ) : (
            <div className="board" role="list">
              {f.stages.map(({ stage, count, amount }) => (
                <section key={stage.id} className="board-col" role="listitem" aria-label={stage.name}>
                  <h3><span>{stage.name}</span><span className="badge">{count}</span></h3>
                  <p className="sum">{money(amount, currency)} · {stage.probability}%</p>
                  {opps.filter((o) => o.stageId === stage.id).map((o) => <Card key={o.id} o={o} />)}
                  {count === 0 ? <p className="muted small">Sin oportunidades</p> : null}
                </section>
              ))}
            </div>
          )}
          {!canRead ? <p className="muted">Tu rol no puede ver oportunidades.</p> : null}
        </>
      ) : (
        <section className="panel" aria-labelledby="closed-title">
          <div className="panel-head"><h2 id="closed-title">{view === 'won' ? 'Ganadas' : 'Perdidas'} (últimas 100)</h2></div>
          {opps.length === 0 ? <p className="muted">No hay oportunidades {view === 'won' ? 'ganadas' : 'perdidas'} en este pipeline.</p> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th scope="col">Oportunidad</th><th scope="col">Cliente</th><th scope="col">Monto</th><th scope="col">Cerrada</th>{view === 'lost' ? <th scope="col">Motivo</th> : null}</tr></thead>
                <tbody>
                  {opps.map((o) => (
                    <tr key={o.id}>
                      <td><Link href={`/opportunities/${o.id}`}>{o.title}</Link></td>
                      <td>{cName.get(o.customerId) ?? <span className="muted">No disponible</span>}</td>
                      <td>{money(o.amount, o.currency)}</td>
                      <td>{o.closedAt ? fmtDate.format(new Date(o.closedAt)) : '—'}</td>
                      {view === 'lost' ? <td>{o.lostReason ?? '—'}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}

/** Opciones de etapa agrupadas: abiertas / ganada / perdida. */
function StageOptions({ stages, current }: { stages: StageRow[]; current: string }) {
  const group = (kind: StageRow['kind'], label: string) => {
    const list = stages.filter((s) => s.kind === kind && s.id !== current);
    return list.length === 0 ? null : (
      <optgroup label={label}>{list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>
    );
  };
  return <>{group('open', 'Etapas abiertas')}{group('won', 'Cerrar como ganada')}{group('lost', 'Cerrar como perdida')}</>;
}
