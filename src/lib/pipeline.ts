import type { OpportunityRow, StageRow } from './types';

export interface StageSummary { stage: StageRow; count: number; amount: number; weighted: number }
export interface Forecast { open: number; amount: number; weighted: number; stages: StageSummary[] }

/**
 * Resumen del embudo. Monto ponderado = monto × probabilidad de la etapa. Solo cuenta oportunidades ABIERTAS
 * y solo de las etapas abiertas que se le pasan. Redondea a 2 decimales al final (no acumula error de coma flotante).
 */
export function forecast(opps: OpportunityRow[], openStages: StageRow[]): Forecast {
  const stages = openStages.map((stage) => {
    const inStage = opps.filter((o) => o.status === 'open' && o.stageId === stage.id);
    const amount = inStage.reduce((s, o) => s + o.amount * 100, 0) / 100;
    return { stage, count: inStage.length, amount, weighted: Math.round(amount * stage.probability) / 100 };
  });
  return {
    open: stages.reduce((s, x) => s + x.count, 0),
    amount: Math.round(stages.reduce((s, x) => s + x.amount * 100, 0)) / 100,
    weighted: Math.round(stages.reduce((s, x) => s + x.weighted * 100, 0)) / 100,
    stages,
  };
}

/** Etapas visibles de un pipeline en orden: abiertas, luego ganada(s), luego perdida(s). Sin archivadas. */
export function orderedStages(stages: StageRow[], includeArchived = false): StageRow[] {
  const rank = { open: 0, won: 1, lost: 2 } as const;
  return stages
    .filter((s) => includeArchived || !s.archivedAt)
    .slice()
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.position - b.position || a.name.localeCompare(b.name));
}
