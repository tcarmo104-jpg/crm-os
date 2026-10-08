/** Piezas visuales que comparten varias pestañas de Analítica (Resumen, Embudo, Desempeño). Solo presentación:
 * reciben lo que ya calculan `buildFunnelWithConversion` y `buildPerformance` en `lib/analytics.ts`. */
import type { FunnelStageRow, PerformanceRow } from '@/lib/analytics';
import { initials } from '@/lib/analytics';
import { chartColor } from '@/components/charts';

/** Embudo centrado que se angosta etapa a etapa; entre etapas, cuánto pasó de una a la siguiente. */
export function FunnelVisual({ stages, money, compact = false }: { stages: FunnelStageRow[]; money: (n: number) => string; compact?: boolean }) {
  const max = Math.max(1, ...stages.map((s) => s.count));
  if (stages.every((s) => s.count === 0)) return <p className="muted">No hay oportunidades abiertas en este pipeline con los filtros elegidos.</p>;
  return (
    <div className="an-funnel" role="list" aria-label="Embudo por etapa">
      {stages.map((s, i) => (
        <div key={s.id} role="listitem" style={{ display: 'contents' }}>
          {i > 0 ? (
            <span className={`an-funnel-conv${s.conversion !== null && s.conversion < 40 ? ' an-funnel-conv--low' : ''}`}>
              {/* Es una foto de hoy: compara cuántas hay ahora en esta etapa contra la anterior, así que puede pasar de 100%. */}
              {s.conversion === null ? 'sin oportunidades en la etapa anterior' : `${s.conversion < 100 ? '↓ ' : ''}equivale al ${s.conversion}% de la etapa anterior`}
            </span>
          ) : null}
          <div className="an-funnel-bar" title={`${s.name}: ${s.count} · ${money(s.amount)}`}
            style={{ width: `${Math.max(compact ? 40 : 34, (s.count / max) * 100)}%`, background: chartColor(i), animationDelay: `${i * 60}ms`, padding: compact ? '8px 14px' : undefined }}>
            <strong>{s.name}</strong>
            <span>{s.count} · {money(s.amount)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Ranking por persona: avatar, equipo, barra de conversión y cifras. Ordenado por monto ganado. */
export function PerformanceRank({ rows, nameOf, teamOf, money, limit }: {
  rows: PerformanceRow[]; nameOf: (id: string) => string; teamOf: (id: string) => string; money: (n: number) => string; limit?: number;
}) {
  const sorted = [...rows].sort((a, b) => b.wonAmount - a.wonAmount || b.won - a.won || b.tasksCompleted - a.tasksCompleted).slice(0, limit ?? rows.length);
  if (sorted.every((r) => r.won === 0 && r.lost === 0 && r.tasksCompleted === 0)) return <p className="muted">Sin actividad en este período.</p>;
  return (
    <div>
      <div className="an-rank-head" aria-hidden="true"><span>#</span><span /><span>Persona</span><span>Conversión</span><span className="an-rank-num">Ganadas</span><span className="an-rank-num">Monto</span><span className="an-rank-num an-rank-num--opt">Perdidas</span><span className="an-rank-num an-rank-num--opt">Tareas</span></div>
      <ol className="an-rank">
        {sorted.map((r, i) => (
          <li key={r.personId}>
            <span className="an-rank-pos">{i + 1}</span>
            <span className="an-avatar" style={{ background: chartColor(i) }} aria-hidden="true">{initials(nameOf(r.personId))}</span>
            <span className="an-rank-name">{nameOf(r.personId)}<small>{teamOf(r.personId)}</small></span>
            <span className="an-rank-rate">
              <span className="dist-bar-track"><span className="dist-bar-fill" style={{ width: `${r.winRate ?? 0}%` }} /></span>
              <span className="an-rank-rate-num">{r.winRate === null ? '—' : `${r.winRate}%`}</span>
            </span>
            <span className="an-rank-num">{r.won}</span>
            <span className="an-rank-num"><strong>{money(r.wonAmount)}</strong></span>
            <span className="an-rank-num an-rank-num--opt">{r.lost}</span>
            <span className="an-rank-num an-rank-num--opt">{r.tasksCompleted}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
