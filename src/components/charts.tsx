/** Gráficos propios en SVG/HTML, sin ninguna librería: evolución (línea/área), columnas, dona y barras.
 * Son componentes de servidor: llegan al navegador como HTML ya dibujado, sin JavaScript extra ni dependencias.
 * Se sienten «vivos» con CSS (animación de entrada y resaltado al pasar el mouse, que respetan
 * `prefers-reduced-motion`) y cada punto, segmento o columna lleva su dato exacto como tooltip nativo. */
import { axisScale, donutSegments } from '@/lib/analytics';

const PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];
export const chartColor = (i: number) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length]!;
const fmtDefault = (n: number) => n.toLocaleString('es');

/** Evolución en el tiempo, para una o varias series. Con `area`, rellena bajo cada línea con un degradado. */
export function TrendLine({ series, height = 220, area = false, format = fmtDefault, colorOffset = 0 }: {
  series: { name: string; points: { label: string; value: number }[] }[]; height?: number; area?: boolean; format?: (n: number) => string; colorOffset?: number;
}) {
  const labels = series[0]?.points.map((p) => p.label) ?? [];
  if (labels.length === 0) return <p className="muted">Sin datos suficientes para este gráfico en el período elegido.</p>;
  const { max } = axisScale(series.flatMap((s) => s.points.map((p) => p.value)));
  const xPct = (i: number) => (labels.length <= 1 ? 50 : (i / (labels.length - 1)) * 100);
  const yPct = (v: number) => 100 - (v / max) * 100;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  // Se dibuja solo en el servidor (no hay hidratación), así que un id aleatorio no puede desincronizarse.
  const uid = Math.random().toString(36).slice(2, 8);

  return (
    <div className="chart">
      <div className="chart-plot" style={{ height }}>
        <div className="chart-yaxis" aria-hidden="true">{[...ticks].reverse().map((t) => <span key={t}>{format(t)}</span>)}</div>
        <div className="chart-area">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="chart-svg" role="img" aria-label={`Evolución: ${series.map((s) => s.name).join(', ')}`}>
            <defs>
              {series.map((s, si) => (
                <linearGradient key={s.name} id={`g${uid}-${si}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" style={{ stopColor: chartColor(si + colorOffset), stopOpacity: 0.3 }} />
                  <stop offset="100%" style={{ stopColor: chartColor(si + colorOffset), stopOpacity: 0 }} />
                </linearGradient>
              ))}
            </defs>
            {ticks.map((t) => <line key={t} x1="0" x2="100" y1={yPct(t)} y2={yPct(t)} className="chart-grid" vectorEffect="non-scaling-stroke" />)}
            {series.map((s, si) => {
              const line = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xPct(i)} ${yPct(p.value)}`).join(' ');
              return (
                <g key={s.name}>
                  {area ? <path d={`${line} L ${xPct(s.points.length - 1)} 100 L ${xPct(0)} 100 Z`} fill={`url(#g${uid}-${si})`} className="chart-fill" /> : null}
                  <path d={line} className="chart-line" style={{ stroke: chartColor(si + colorOffset) }} vectorEffect="non-scaling-stroke" />
                </g>
              );
            })}
          </svg>
          {/* Los puntos van en HTML (no se deforman al estirar el SVG) y llevan el dato exacto como tooltip. */}
          {series.map((s, si) => s.points.map((p, i) => (
            <span key={`${s.name}-${i}`} className="chart-dot" style={{ left: `${xPct(i)}%`, top: `${yPct(p.value)}%`, background: chartColor(si + colorOffset) }}
              title={`${s.name} · ${p.label}: ${format(p.value)}`} />
          )))}
        </div>
      </div>
      <div className="chart-xlabels" aria-hidden="true">
        <span>{labels[0]}</span>
        {labels.length > 2 ? <span>{labels[Math.floor(labels.length / 2)]}</span> : null}
        {labels.length > 1 ? <span>{labels[labels.length - 1]}</span> : null}
      </div>
      <div className="trend-legend">
        {series.map((s, si) => <span key={s.name} className="trend-legend-item"><span className="trend-dot" style={{ background: chartColor(si + colorOffset) }} />{s.name}</span>)}
      </div>
    </div>
  );
}

/** Columnas verticales (p. ej. ventas por mes), con el valor encima y el dato exacto como tooltip. */
export function ColumnChart({ rows, height = 220, format = fmtDefault, colorIndex = 0 }: {
  rows: { label: string; value: number; sub?: string }[]; height?: number; format?: (n: number) => string; colorIndex?: number;
}) {
  if (rows.length === 0) return <p className="muted">Sin datos en este período.</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="colchart" style={{ height }} role="img" aria-label={rows.map((r) => `${r.label}: ${format(r.value)}`).join('; ')}>
      {rows.map((r, i) => (
        <div key={r.label} className="colchart-col" title={`${r.label}: ${format(r.value)}${r.sub ? ` · ${r.sub}` : ''}`}>
          <span className="colchart-value">{format(r.value)}</span>
          <span className="colchart-track"><span className="colchart-bar" style={{ height: `${Math.max(2, (r.value / max) * 100)}%`, background: chartColor(colorIndex), animationDelay: `${i * 40}ms` }} /></span>
          <span className="colchart-label">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Tamaño de la cifra central para que quepa en el hueco de la dona (~74% del diámetro). */
export function centerFontSize(text: string, size: number): string {
  const hole = size * 0.58;                      // ancho útil dentro del aro, con margen para que respire
  const px = Math.min(22, Math.max(11, hole / (Math.max(text.length, 1) * 0.62)));
  return `${Math.round(px)}px`;
}

/** Dona de distribución (por canal, por fuente, por equipo…), con el total al centro y leyenda con %. */
export function Donut({ rows, centerLabel = 'Total', format = fmtDefault, size = 168 }: {
  rows: { label: string; value: number }[]; centerLabel?: string; format?: (n: number) => string; size?: number;
}) {
  const segs = donutSegments(rows);
  if (segs.length === 0) return <p className="muted">Sin datos en este período.</p>;
  const total = segs.reduce((t, s) => t + s.value, 0);
  const R = 15.9155;   // circunferencia = 100: cada % es una unidad de trazo
  const gap = segs.length > 1 ? 0.6 : 0;
  return (
    <div className="donut">
      <div className="donut-figure" style={{ width: size, height: size }}>
        <svg viewBox="0 0 42 42" className="donut-svg" role="img" aria-label={segs.map((s) => `${s.label}: ${s.pct}%`).join('; ')}>
          <circle cx="21" cy="21" r={R} className="donut-track" />
          {segs.map((s, i) => (
            <circle key={s.label} cx="21" cy="21" r={R} className="donut-seg" style={{ stroke: chartColor(i) }}
              strokeDasharray={`${Math.max(0, s.pct - gap)} ${100 - s.pct + gap}`} strokeDashoffset={25 - s.offset}>
              <title>{`${s.label}: ${format(s.value)} (${s.pct}%)`}</title>
            </circle>
          ))}
        </svg>
        {/* La cifra del centro se achica según su largo: un monto como «US$ 12.450.000» no debe salirse del aro. */}
        <div className="donut-center"><strong style={{ fontSize: centerFontSize(format(total), size) }}>{format(total)}</strong><span>{centerLabel}</span></div>
      </div>
      <ul className="donut-legend">
        {segs.map((s, i) => (
          <li key={s.label}><span className="trend-dot" style={{ background: chartColor(i) }} /><span className="donut-legend-label">{s.label}</span><span className="donut-legend-value">{format(s.value)}</span><span className="donut-legend-pct">{s.pct}%</span></li>
        ))}
      </ul>
    </div>
  );
}

/** Barras horizontales para una distribución (por canal, por equipo, por región…). */
export function DistBar({ rows, valueLabel = (n: number) => String(n) }: { rows: { label: string; count: number }[]; valueLabel?: (n: number) => string }) {
  if (rows.length === 0) return <p className="muted">Sin datos en este período.</p>;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="dist-bar-list">
      {rows.map((r, i) => (
        <li key={r.label} className="dist-bar-row" title={`${r.label}: ${valueLabel(r.count)}`}>
          <span className="dist-bar-label">{r.label}</span>
          <span className="dist-bar-track"><span className="dist-bar-fill" style={{ width: `${Math.max(4, (r.count / max) * 100)}%`, animationDelay: `${i * 50}ms` }} /></span>
          <span className="dist-bar-value">{valueLabel(r.count)}</span>
        </li>
      ))}
    </ul>
  );
}
