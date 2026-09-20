import { describe, expect, it } from 'vitest';
import { forecast, orderedStages } from './pipeline';
import type { OpportunityRow, StageRow } from './types';

const st = (id: string, kind: StageRow['kind'], position: number, probability: number, archivedAt: string | null = null): StageRow =>
  ({ id, pipelineId: 'p', name: id, kind, position, probability, archivedAt });
const op = (id: string, stageId: string, amount: number, status: OpportunityRow['status'] = 'open'): OpportunityRow => ({
  id, customerId: 'c', pipelineId: 'p', stageId, title: id, amount, currency: 'COP', expectedCloseDate: null, productInterest: null,
  status, lostReason: null, closedAt: null, ownerId: null, customFields: {}, createdAt: '2026-01-01T00:00:00Z',
  number: 'OPP-0001', priority: 'medium', temperature: null, channel: null, conversationId: null,
});

describe('forecast', () => {
  const stages = [st('a', 'open', 10, 10), st('b', 'open', 20, 50)];
  it('suma monto y monto ponderado por etapa', () => {
    const f = forecast([op('1', 'a', 1000), op('2', 'a', 500), op('3', 'b', 2000)], stages);
    expect(f.open).toBe(3);
    expect(f.amount).toBe(3500);
    expect(f.stages[0]).toMatchObject({ count: 2, amount: 1500, weighted: 150 });
    expect(f.weighted).toBe(1150);   // 150 + 1000
  });
  it('ignora oportunidades cerradas y de etapas que no se pasan', () => {
    const f = forecast([op('1', 'a', 100, 'won'), op('2', 'zzz', 999), op('3', 'b', 10, 'lost')], stages);
    expect(f).toMatchObject({ open: 0, amount: 0, weighted: 0 });
  });
  it('no acumula error de coma flotante', () => {
    const many = Array.from({ length: 10 }, (_, i) => op(String(i), 'a', 0.1));
    expect(forecast(many, stages).amount).toBe(1);
  });
});

describe('orderedStages', () => {
  it('abiertas por posición, luego ganada y perdida; oculta archivadas', () => {
    const all = [st('lost', 'lost', 10, 0), st('b', 'open', 20, 50), st('won', 'won', 10, 100), st('a', 'open', 10, 10), st('old', 'open', 5, 5, '2026-01-01')];
    expect(orderedStages(all).map((s) => s.id)).toEqual(['a', 'b', 'won', 'lost']);
    expect(orderedStages(all, true).map((s) => s.id)).toEqual(['old', 'a', 'b', 'won', 'lost']);
  });
});
