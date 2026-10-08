import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listOpportunities } from '@/repositories/opportunities';
import { listPipelines } from '@/repositories/pipelines';
import { buildFunnelWithConversion } from '@/lib/analytics';
import { loadAnalyticsScope } from '@/services/analytics-scope';
import { formatMoney } from '@/lib/money';
import { Kpi, Notice } from '@/components/ui';
import { FilterSelect } from '@/components/filters';
import { Donut } from '@/components/charts';
import { FunnelVisual } from '@/components/analytics-parts';

export const metadata: Metadata = { title: 'Analítica — Embudo' };
type SP = Record<string, string | string[] | undefined>;

/** Embudo (lo que antes era /funnel): oportunidades abiertas por etapa, ahora mismo. Ahora también respeta los
 * filtros de asesor y equipo (como ya lo hacía el embudo del Dashboard); el período no aplica: es una foto de hoy. */
export default async function AnalyticsFunnelPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'reports:read')) return <Notice kind="error">No tienes acceso a este módulo.</Notice>;
  const db = await createClient();

  const [scope, pipelines, openOppsAll] = await Promise.all([
    loadAnalyticsScope(db, org, sp),
    listPipelines(db, org.orgId),
    listOpportunities(db, { orgId: org.orgId, status: 'open', limit: 2000 }),
  ]);
  const wanted = Array.isArray(sp.pipeline) ? sp.pipeline[0] : sp.pipeline;
  const pipeline = pipelines.find((p) => p.id === wanted) ?? pipelines[0];
  const money = (n: number) => formatMoney(n, null, org.orgLocale);

  if (!pipeline) return <section className="panel"><div className="empty"><p><strong>Todavía no hay ningún pipeline configurado.</strong></p></div></section>;

  const opps = openOppsAll.filter((o) => o.pipelineId === pipeline.id && scope.matches(o.ownerId));
  const funnel = buildFunnelWithConversion(pipeline.stages.filter((s) => s.kind === 'open'), opps);
  const total = opps.reduce((t, o) => t + o.amount, 0);
  const weakest = funnel.filter((f) => f.conversion !== null).sort((a, b) => a.conversion! - b.conversion!)[0];
  const today = new Date().toISOString().slice(0, 10);
  const overdue = opps.filter((o) => o.expectedCloseDate && o.expectedCloseDate < today).length;

  return (
    <>
      {pipelines.length > 1 ? (
        <div className="flt-bar"><FilterSelect basePath="/analytics/embudo" param="pipeline" label="Pipeline" value={pipeline.id === pipelines[0]?.id ? '' : pipeline.id} allLabel={pipelines[0]?.name ?? 'Todos'} options={pipelines.slice(1).map((p) => ({ value: p.id, label: p.name }))} /></div>
      ) : null}

      <section className="kpi-grid" aria-label="Indicadores del embudo">
        <Kpi href="/opportunities" icon="target" label="Oportunidades abiertas" value={String(opps.length)} sub={`en el pipeline «${pipeline.name}»`} tone="primary" />
        <Kpi href="/opportunities" icon="cash" label="Valor del embudo" value={money(total)} sub={opps.length ? `promedio ${money(total / opps.length)}` : 'sin oportunidades'} tone="ok" />
        <Kpi href="/opportunities" icon="funnel" label="Etapa con más caída" value={weakest ? `${weakest.conversion}%` : '—'} sub={weakest ? `llega a «${weakest.name}»` : 'sin datos suficientes'} tone={weakest && weakest.conversion! < 40 ? 'warn' : 'neutral'} />
        <Kpi href="/opportunities" icon="bolt" label="Con cierre vencido" value={String(overdue)} sub="fecha de cierre esperada ya pasó" tone={overdue > 0 ? 'danger' : 'neutral'} />
      </section>

      <div className="an-grid-wide">
        <section className="panel" aria-labelledby="funnel-title">
          <div className="panel-head"><h2 id="funnel-title">{pipeline.name}</h2></div>
          <p className="an-panel-sub">Cuántas oportunidades abiertas hay en cada etapa ahora mismo, y qué tanto avanza de una etapa a la siguiente.</p>
          <FunnelVisual stages={funnel} money={money} />
        </section>
        <section className="panel" aria-labelledby="funnel-amount-title">
          <div className="panel-head"><h2 id="funnel-amount-title">Valor por etapa</h2></div>
          <Donut rows={funnel.map((f) => ({ label: f.name, value: f.amount }))} centerLabel="en el embudo" format={money} />
        </section>
      </div>
    </>
  );
}
