import { describe, expect, it } from 'vitest';
import { buildHistory } from './kanban-history';
import type { ActivityRow, TransitionRow } from './types';

const name = (id: string | null) => (id === 'u1' ? 'Yeison' : id === 'u2' ? 'Laura' : 'Alguien');
const tr = (o: Partial<TransitionRow> & { id: string; occurredAt: string }): TransitionRow => ({ entityType: 'opportunity', entityId: 'o', fromState: 'Cotización', toState: 'Negociación', actorId: 'u1', source: 'user', reason: null, ...o });
const ac = (o: Partial<ActivityRow> & { id: string; occurredAt: string }): ActivityRow => ({ customerId: 'c', opportunityId: 'o', type: 'call', direction: 'outbound', summary: 'Le llamé', createdBy: 'u2', ...o });

describe('historial de la oportunidad', () => {
  it('dice quién movió qué, de qué etapa a cuál', () => {
    const [h] = buildHistory([tr({ id: '1', occurredAt: '2026-09-19T10:00:00Z' })], [], name);
    expect(h).toMatchObject({ kind: 'stage', text: 'Yeison movió la oportunidad de Cotización a Negociación.', detail: null });
  });
  it('la creación (sin etapa anterior) y los cambios del sistema tienen su propio texto', () => {
    const h = buildHistory([tr({ id: '1', occurredAt: '2026-09-19T10:00:00Z', fromState: null, toState: 'Nueva' }), tr({ id: '2', occurredAt: '2026-09-19T11:00:00Z', actorId: null, fromState: 'Nueva', toState: 'Ganada', source: 'system' })], [], name);
    expect(h.map((x) => x.text)).toEqual(['El sistema movió la oportunidad de Nueva a Ganada.', 'Yeison creó la oportunidad en «Nueva».']);
  });
  it('el motivo de una pérdida aparece como detalle', () => {
    const [h] = buildHistory([tr({ id: '1', occurredAt: '2026-09-19T10:00:00Z', toState: 'Perdida', reason: 'Compró con la competencia' })], [], name);
    expect(h!.detail).toBe('Motivo: Compró con la competencia');
  });
  it('mezcla actividades y etapas, lo más reciente primero, con desempate estable', () => {
    const h = buildHistory(
      [tr({ id: 'a', occurredAt: '2026-09-19T10:00:00Z' }), tr({ id: 'b', occurredAt: '2026-09-19T12:00:00Z' })],
      [ac({ id: 'x', occurredAt: '2026-09-19T11:00:00Z', type: 'meeting', summary: 'Reunión en sitio' }), ac({ id: 'y', occurredAt: '2026-09-19T12:00:00Z', type: 'whatsapp' })], name);
    expect(h.map((x) => x.id)).toEqual(['t-b', 'a-y', 'a-x', 't-a']);
    expect(h.find((x) => x.id === 'a-x')).toMatchObject({ text: 'Laura registró una reunión.', detail: 'Reunión en sitio' });
    expect(h.find((x) => x.id === 'a-y')!.text).toBe('Laura registró un mensaje de WhatsApp.');
  });
  it('un tipo de actividad desconocido no rompe nada', () => {
    const [h] = buildHistory([], [ac({ id: 'z', occurredAt: '2026-09-19T10:00:00Z', type: 'raro' })], name);
    expect(h!.text).toBe('Laura registró una actividad.');
    expect(buildHistory([], [], name)).toEqual([]);
  });
});
