import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import {
  autoGranularity, breakdownWidgetFacts, buildTimeSeries, formatDuration, parseWidgetFilters, pctChange, summarizeWidgetFacts, widgetFilterOptions,
  WIDGET_DIMENSIONS, WIDGET_DIMENSION_LABEL, type WidgetFilters,
} from '@/lib/analytics';
import { loadWidgetMetrics } from '@/services/widget-metrics';
import { WIDGET_FACTS_LIMIT } from '@/repositories/widget-metrics';
import { formatMoney } from '@/lib/money';
import { Kpi, Notice } from '@/components/ui';
import { FilterSelect } from '@/components/filters';
import { ExportCsvLink } from '@/components/period-filter';
import { TrendLine, DistBar, Donut } from '@/components/charts';

export const metadata: Metadata = { title: 'Analítica — Widget de WhatsApp' };

type SP = Record<string, string | string[] | undefined>;
const BASE = '/analytics/widget';

/** Los filtros actuales como parámetros de URL (para los enlaces del desglose y la exportación). */
function filterParams(f: WidgetFilters): Record<string, string | string[] | undefined> {
  return { desde: f.desde, hasta: f.hasta, personas: f.personas, equipos: f.equipos, widget: f.widget, pagina: f.pagina, producto: f.producto, campana: f.campana, region: f.region };
}
function hrefWith(f: WidgetFilters, por: string): string {
  const qs = new URLSearchParams();
  if (f.periodo !== 'this_month') qs.set('periodo', f.periodo);
  for (const [k, v] of Object.entries(filterParams(f))) for (const x of Array.isArray(v) ? v : v ? [v] : []) qs.append(k, x);
  qs.set('por', por);
  return `${BASE}?${qs}`;
}
const pct = (n: number | null) => (n === null ? '—' : `${n}%`);

export default async function WidgetMetricsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'reports:read')) return <Notice kind="error">No tienes acceso a este módulo.</Notice>;
  const db = await createClient();
  const canExport = can(session, 'reports:export');

  const filters = parseWidgetFilters(sp);
  const data = await loadWidgetMetrics(db, org, filters);
  const s = summarizeWidgetFacts(data.facts);
  const p = summarizeWidgetFacts(data.previous);
  const money = (n: number) => formatMoney(n, null, org.orgLocale);


  const granularity = autoGranularity(data.range);
  const tStarted = buildTimeSeries(data.facts.map((f) => ({ at: f.receivedAt })), org.orgTimezone, granularity);
  const tOpps = buildTimeSeries(data.facts.filter((f) => f.opportunityId).map((f) => ({ at: f.receivedAt })), org.orgTimezone, granularity);
  const keys = [...new Set([...tStarted, ...tOpps].map((b) => b.key))].sort();
  const series = (b: typeof tStarted) => keys.map((k) => { const x = b.find((y) => y.key === k); return { label: x?.label ?? k, value: x?.count ?? 0 }; });

  const rows = breakdownWidgetFacts(data.facts, filters.por, data.labelOf(filters.por));
  const opt = (d: 'widget' | 'pagina' | 'producto' | 'campana' | 'region') => widgetFilterOptions(data.all, d, data.labelOf(d));
  const extraSelects = [
    { param: 'widget', label: 'Widget', value: filters.widget, options: opt('widget') },
    { param: 'pagina', label: 'Página', value: filters.pagina, options: opt('pagina') },
    { param: 'producto', label: 'Producto', value: filters.producto, options: opt('producto') },
    { param: 'campana', label: 'Campaña', value: filters.campana, options: opt('campana') },
    { param: 'region', label: 'Región', value: filters.region, options: opt('region') },
  ];
  const ofStarted = (n: number) => (s.started === 0 ? '' : ` (${Math.round((n / s.started) * 100)}%)`);

  return (
    <>
      <p className="muted" style={{ margin: 0 }}>Qué tan bien convierten las conversaciones que llegan por el botón de WhatsApp de tus sitios web: de dónde vienen, quién las atiende y cuántas terminan en venta.</p>
      <div className="flt-bar" aria-label="Filtros del widget">
        {extraSelects.map((e) => <FilterSelect key={e.param} basePath={BASE} param={e.param} label={e.label} value={e.value ?? ''} options={e.options} />)}
      </div>

      {data.truncated ? <p className="notice" role="status">{`Hay más de ${WIDGET_FACTS_LIMIT.toLocaleString(org.orgLocale)} conversaciones en este período: se muestran las más recientes. Acota el período para ver el total exacto.`}</p> : null}

      {data.all.length === 0 ? (
        <section className="panel"><div className="empty">
          <p><strong>Todavía no hay conversaciones del widget en este período.</strong></p>
          <p className="muted">Cuando alguien escriba desde el botón de WhatsApp de tu sitio web, aparecerá aquí. <Link href="/settings/whatsapp-widgets">Configurar widgets →</Link></p>
        </div></section>
      ) : (
        <>
          <section className="kpi-grid" aria-label="Indicadores del widget">
            <Kpi href="/leads?fuente=widget_web" icon="chat" label="Conversaciones iniciadas" value={String(s.started)} sub={`${s.reachedWhatsapp} escribieron por WhatsApp${ofStarted(s.reachedWhatsapp)}`} tone="primary" delta={p.started > 0 ? pctChange(s.started, p.started) : null} />
            <Kpi href="/leads?fuente=widget_web" icon="users" label="Contactos nuevos" value={String(s.newContacts)} sub={`${s.returning} ${s.returning === 1 ? 'recurrente' : 'recurrentes'} (ya eran clientes)`} tone="neutral" />
            <Kpi href="/opportunities" icon="target" label="Conversación → oportunidad" value={pct(s.oppRate)} sub={`${s.opportunities} ${s.opportunities === 1 ? 'oportunidad' : 'oportunidades'}`} tone="neutral" delta={p.opportunities > 0 ? pctChange(s.opportunities, p.opportunities) : null} />
            <Kpi href="/sales" icon="cash" label="Conversación → venta" value={pct(s.saleRate)} sub={s.sales === 0 ? 'sin ventas aún' : `${s.sales} ${s.sales === 1 ? 'venta' : 'ventas'} · ${money(s.salesAmount)}`} tone={s.sales > 0 ? 'ok' : 'neutral'} delta={p.sales > 0 ? pctChange(s.sales, p.sales) : null} />
            <Kpi href="/inbox" icon="bolt" label="Primera respuesta (promedio)" value={formatDuration(s.avgFirstResponseMs)} sub={s.answered === 0 ? 'ninguna respondida aún' : `mediana ${formatDuration(s.medianFirstResponseMs)} · ${s.unanswered} sin responder`} tone={s.unanswered > 0 ? 'warn' : 'neutral'} />
            <Kpi href="/inbox" icon="check" label="Resolución (promedio)" value={formatDuration(s.avgResolutionMs)} sub={s.resolved === 0 ? 'ninguna cerrada aún' : `mediana ${formatDuration(s.medianResolutionMs)} · ${s.resolved} cerradas`} tone="neutral" />
          </section>

          <div className="an-grid-2">
            <section className="panel" aria-labelledby="wf-funnel-title">
              <div className="panel-head"><h2 id="wf-funnel-title">Embudo del widget</h2></div>
              <DistBar rows={[
                { label: 'Formulario', count: s.started },
                { label: 'Escribieron', count: s.reachedWhatsapp },
                { label: 'Respondidas', count: s.answered },
                { label: 'Oportunidad', count: s.opportunities },
                { label: 'Venta', count: s.sales },
              ]} valueLabel={(n) => `${n}${ofStarted(n)}`} />
              <p className="hint">Llenaron el formulario → escribieron por WhatsApp → un asesor les respondió → pasaron a oportunidad → compraron.</p>
              {s.opportunities > 0 ? <p className="hint">De las oportunidades, {pct(s.oppToSaleRate)} terminaron en venta.</p> : null}
            </section>
            <section className="panel" aria-labelledby="wf-trend-title">
              <div className="panel-head"><h2 id="wf-trend-title">Evolución</h2></div>
              <TrendLine area series={[{ name: 'Conversaciones iniciadas', points: series(tStarted) }, { name: 'Con oportunidad', points: series(tOpps) }]} />
            </section>
          </div>

          <section className="panel" aria-labelledby="wf-bd-title">
            <div className="panel-head" style={{ flexWrap: 'wrap', gap: 10 }}>
              <h2 id="wf-bd-title">Por {WIDGET_DIMENSION_LABEL[filters.por].toLowerCase()}</h2>
              <nav className="tabs" aria-label="Desglosar por">
                {WIDGET_DIMENSIONS.map((d) => <Link key={d} href={hrefWith(filters, d)} aria-current={d === filters.por ? 'page' : undefined}>{WIDGET_DIMENSION_LABEL[d]}</Link>)}
              </nav>
              {canExport ? <ExportCsvLink type="widget" preset={filters.periodo} desde={filters.desde} hasta={filters.hasta} extra={{ ...filterParams(filters), desde: undefined, hasta: undefined, por: filters.por }} /> : null}
            </div>
            {rows.length === 0 ? <p className="muted">Ninguna conversación coincide con los filtros.</p> : (<>
              <Donut rows={rows.map((r) => ({ label: r.label, value: r.summary.started }))} centerLabel="conversaciones" />
              <div className="table-wrap">
                <table className="table">
                  <thead><tr>
                    <th scope="col">{WIDGET_DIMENSION_LABEL[filters.por]}</th><th scope="col">Iniciadas</th><th scope="col">Nuevos</th><th scope="col">Escribieron</th>
                    <th scope="col">Oportunidades</th><th scope="col">Ventas</th><th scope="col">Monto</th><th scope="col">1.ª respuesta</th>
                  </tr></thead>
                  <tbody>{rows.map((r) => (
                    <tr key={r.key}>
                      <td>{r.label}</td><td className="small">{r.summary.started}</td><td className="small">{r.summary.newContacts}</td><td className="small">{r.summary.reachedWhatsapp}</td>
                      <td className="small">{r.summary.opportunities} <span className="muted">({pct(r.summary.oppRate)})</span></td>
                      <td className="small">{r.summary.sales} <span className="muted">({pct(r.summary.saleRate)})</span></td>
                      <td className="small">{money(r.summary.salesAmount)}</td><td className="small">{formatDuration(r.summary.avgFirstResponseMs)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </>)}
          </section>

          <details className="panel">
            <summary className="small">Cómo se calcula cada número</summary>
            <ul className="small muted">
              <li><strong>Conversación iniciada</strong>: cada vez que alguien llena el formulario del widget (cada una crea un lead).</li>
              <li><strong>Escribió por WhatsApp</strong>: el visitante envió de verdad el mensaje en WhatsApp dentro de las 24 h siguientes.</li>
              <li><strong>Nuevo / recurrente</strong>: nuevo si el teléfono no existía como cliente; recurrente si ya existía.</li>
              <li><strong>Primera respuesta</strong>: desde su primer mensaje hasta la primera respuesta escrita por una persona (los mensajes automáticos no cuentan).</li>
              <li><strong>Resolución</strong>: desde su primer mensaje hasta que se cerró la conversación. Se mide desde que se instaló esta versión: los cierres anteriores no quedaron registrados.</li>
              <li><strong>Oportunidad / venta</strong>: la oportunidad creada para ese cliente después del formulario (incluida la del botón del Inbox), y su venta si no se anuló. Si el cliente vuelve a usar el widget, lo que pase después se cuenta para la conversación nueva.</li>
              <li>Ves las conversaciones que tu rol ya te deja ver en Leads.</li>
            </ul>
          </details>
        </>
      )}
    </>
  );
}
