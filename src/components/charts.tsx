/** Gráficos propios en SVG, sin ninguna librería nueva: una línea de evolución y una lista de barras.
 * Se renderizan en el servidor (sin JavaScript en el navegador) — coherente con «nada de gráficos
 * decorativos, nada de JS de más», y evita agregar una dependencia nueva al proyecto. */

const COLORS = ['var(--primary)', 'var(--ok)', 'var(--warn)'];

/** Línea de evolución para una o varias series (leads/oportunidades/ventas en el tiempo). */
export function TrendLine({ series, height = 220 }: { series: { name: string; points: { label: string; value: number }[] }[]; height?: number }) {
  const labels = series[0]?.points.map((p) => p.label) ?? [];
  const allValues = series.flatMap((s) => s.points.map((p) => p.value));
  const max = Math.max(1, ...allValues);
  const w = 100, h = 100, padY = 8;
  const x = (i: number) => (labels.length <= 1 ? w / 2 : (i / (labels.length - 1)) * w);
  const y = (v: number) => h - padY - (v / max) * (h - padY * 2);

  if (labels.length === 0) return <p className="muted">Sin datos suficientes para este gráfico en el período elegido.</p>;

  return (
    <div className="trend-chart">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="trend-svg" role="img" aria-label="Evolución en el tiempo">
        <line x1="0" y1={h - padY} x2={w} y2={h - padY} className="trend-axis" />
        {series.map((s, si) => {
          const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.value)}`).join(' ');
          const color = COLORS[si % COLORS.length];
          return (
            <g key={s.name}>
              <path d={d} className="trend-line" style={{ stroke: color }} vectorEffect="non-scaling-stroke" />
              {s.points.map((p, i) => (p.value > 0 ? <circle key={i} cx={x(i)} cy={y(p.value)} r={labels.length <= 8 ? 1.6 : 0} style={{ fill: color }} /> : null))}
            </g>
          );
        })}
      </svg>
      <div className="trend-legend">
        {series.map((s, si) => (
          <span key={s.name} className="trend-legend-item">
            <span className="trend-dot" style={{ background: COLORS[si % COLORS.length] }} />
            {s.name}
          </span>
        ))}
      </div>
      <div className="trend-labels">
        <span>{labels[0]}</span>
        {labels.length > 1 ? <span>{labels[labels.length - 1]}</span> : null}
      </div>
    </div>
  );
}

/** Barras horizontales para una distribución (por canal, por equipo, por región…). */
export function DistBar({ rows, valueLabel = (n: number) => String(n) }: { rows: { label: string; count: number }[]; valueLabel?: (n: number) => string }) {
  if (rows.length === 0) return <p className="muted">Sin datos en este período.</p>;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="dist-bar-list">
      {rows.map((r) => (
        <li key={r.label} className="dist-bar-row">
          <span className="dist-bar-label">{r.label}</span>
          <span className="dist-bar-track"><span className="dist-bar-fill" style={{ width: `${Math.max(4, (r.count / max) * 100)}%` }} /></span>
          <span className="dist-bar-value">{valueLabel(r.count)}</span>
        </li>
      ))}
    </ul>
  );
}
