import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listOpportunities } from '@/repositories/opportunities';
import { listPipelines } from '@/repositories/pipelines';
import { buildFunnelWithConversion } from '@/lib/analytics';
import { formatMoney } from '@/lib/money';
import { Notice } from '@/components/ui';
import { FilterSelect } from '@/components/filters';

export const metadata: Metadata = { title: 'Embudo' };

export default async function FunnelPage({ searchParams }: { searchParams: Promise<{ pipeline?: string }> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'reports:read')) return <><header className="page-head"><h1>Embudo</h1></header><Notice kind="error">No tienes acceso a este módulo.</Notice></>;
  const db = await createClient();

  const [pipelines, openOpps] = await Promise.all([listPipelines(db, org.orgId), listOpportunities(db, { orgId: org.orgId, status: 'open', limit: 2000 })]);
  const pipeline = pipelines.find((p) => p.id === sp.pipeline) ?? pipelines[0];
  const money = (n: number) => formatMoney(n, null, org.orgLocale);

  if (!pipeline) return (
    <>
      <header className="page-head"><h1>Embudo</h1></header>
      <div className="empty-state"><strong>Todavía no hay ningún pipeline configurado.</strong></div>
    </>
  );

  const funnel = buildFunnelWithConversion(pipeline.stages.filter((s) => s.kind === 'open'), openOpps.filter((o) => o.pipelineId === pipeline.id));
  const totalCount = funnel.reduce((t, f) => t + f.count, 0);

  return (
    <>
      <header className="page-head">
        <h1>Embudo</h1>
        <p className="muted">Cuántas oportunidades abiertas hay en cada etapa ahora mismo, y qué tanto avanza de una etapa a la siguiente.</p>
      </header>

      {pipelines.length > 1 ? (
        <div className="flt-bar"><FilterSelect basePath="/funnel" param="pipeline" label="Pipeline" value={pipeline.id === pipelines[0]?.id ? '' : pipeline.id} allLabel={pipelines[0]?.name ?? 'Todos'} options={pipelines.slice(1).map((p) => ({ value: p.id, label: p.name }))} /></div>
      ) : null}

      <section className="panel" aria-labelledby="funnel-title">
        <div className="panel-head"><h2 id="funnel-title">{pipeline.name}</h2></div>
        {totalCount === 0 ? (
          <p className="muted">No hay oportunidades abiertas en este pipeline.</p>
        ) : (
          <div className="funnel-big funnel-big-lg">
            {funnel.map((f, i) => (
              <div key={f.id} className="funnel-big-stage">
                <div className="funnel-big-bar" style={{ width: `${totalCount === 0 ? 0 : Math.max(4, (f.count / totalCount) * 100)}%` }} />
                <span className="funnel-big-name">{f.name}</span>
                <span className="funnel-big-count">{f.count} {f.count === 1 ? 'oportunidad' : 'oportunidades'}</span>
                <span className="funnel-big-amount">{money(f.amount)}</span>
                {f.conversion !== null ? (
                  <span className={`funnel-big-conv ${f.conversion < 40 ? 'funnel-big-conv--low' : ''}`}>{f.conversion}% pasó de la etapa anterior</span>
                ) : i === 0 ? (
                  <span className="funnel-big-conv">Primera etapa</span>
                ) : (
                  <span className="funnel-big-conv">Sin oportunidades en la etapa anterior</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
