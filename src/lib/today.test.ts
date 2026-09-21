import { describe, expect, it } from 'vitest';
import type { BoardCard } from './kanban';
import type { StageRow } from './types';
import { nextAction, stageFunnel, timeAgo, type NextActionInput } from './today';

const st = (id: string, name: string, position: number, kind: StageRow['kind'] = 'open', archivedAt: string | null = null): StageRow => ({ id, pipelineId: 'p', name, kind, position, probability: 0, archivedAt });
const card = (id: string, stageId: string, amount: number, status: BoardCard['status'] = 'open'): BoardCard => ({ id, number: id, title: id, amount, currency: 'COP', stageId, status, priority: 'medium', temperature: null, channel: null, customerId: 'c', customerName: 'C', ownerId: null, ownerName: null, createdAt: '2026-01-01', expectedCloseDate: null, product: null, conversationId: null, lostReason: null });

describe('embudo por etapa', () => {
  const stages = [st('b', 'Contactado', 2), st('a', 'Nueva', 1), st('w', 'Ganada', 9, 'won'), st('l', 'Perdida', 10, 'lost'), st('z', 'Vieja', 3, 'open', '2026-01-01')];
  it('solo etapas abiertas y vigentes, en el orden del embudo', () => {
    expect(stageFunnel(stages, []).map((r) => r.name)).toEqual(['Nueva', 'Contactado']);
  });
  it('suma valor y cantidad de las oportunidades ABIERTAS de cada etapa; ignora ganadas/perdidas', () => {
    const rows = stageFunnel(stages, [card('1', 'a', 1000), card('2', 'a', 500), card('3', 'b', 3000), card('4', 'a', 9999, 'won'), card('5', 'b', 9999, 'lost')]);
    expect(rows).toEqual([{ id: 'a', name: 'Nueva', count: 2, amount: 1500, pct: 50 }, { id: 'b', name: 'Contactado', count: 1, amount: 3000, pct: 100 }]);
  });
  it('sin valores, la barra usa la cantidad; sin nada, 0 %', () => {
    expect(stageFunnel(stages, [card('1', 'a', 0), card('2', 'a', 0), card('3', 'b', 0)]).map((r) => r.pct)).toEqual([100, 50]);
    expect(stageFunnel(stages, []).map((r) => r.pct)).toEqual([0, 0]);
    expect(stageFunnel(stages, [card('1', 'a', Number.NaN)])[0]!.amount).toBe(0);
  });
});

const base = (o: Partial<NextActionInput> = {}): NextActionInput => ({ overdue: [], today: [], pendingReplies: 0, firstPending: null, customerCount: 5, openOpportunities: 3, can: { tasks: true, inbox: true, customers: true, opportunities: true }, ...o });
describe('«tu próxima acción»: lo primero que hay que hacer', () => {
  it('lo atrasado va primero, y lleva al cliente de la tarea (o a Tareas)', () => {
    const a = nextAction(base({ overdue: [{ title: 'Llamar a Ana', customerId: 'c1' }, { title: 'x', customerId: null }], pendingReplies: 4, firstPending: { id: 'v1', name: 'Beto' } }));
    expect(a).toMatchObject({ tone: 'urgent', eyebrow: 'Atrasada', title: 'Llamar a Ana', href: '/customers/c1' }); expect(a.detail).toBe('Tienes 2 tareas vencidas. Empieza por esta.');
    expect(nextAction(base({ overdue: [{ title: 'x', customerId: null }] })).href).toBe('/tasks');
    expect(nextAction(base({ overdue: [{ title: 'x', customerId: null }] })).detail).toMatch(/1 tarea vencida\./);
  });
  it('sin atrasos, una conversación que espera respuesta', () => {
    expect(nextAction(base({ pendingReplies: 1, firstPending: { id: 'v1', name: 'Beto' } }))).toMatchObject({ tone: 'urgent', title: 'Responde a Beto', href: '/inbox?c=v1', cta: 'Abrir conversación', detail: 'Hay 1 conversación esperando tu respuesta.' });
    expect(nextAction(base({ pendingReplies: 3, firstPending: { id: 'v1', name: 'Beto' } })).detail).toBe('Hay 3 conversaciones esperando tu respuesta.');
  });
  it('luego lo de hoy, luego empezar (clientes, oportunidades) y, si todo está bien, «al día»', () => {
    expect(nextAction(base({ today: [{ title: 'Enviar cotización', customerId: null }] }))).toMatchObject({ tone: 'todo', eyebrow: 'Para hoy', title: 'Enviar cotización' });
    expect(nextAction(base({ customerCount: 0 }))).toMatchObject({ eyebrow: 'Empieza aquí', href: '/customers/new' });
    expect(nextAction(base({ openOpportunities: 0 }))).toMatchObject({ eyebrow: 'Siguiente paso', href: '/opportunities/new' });
    expect(nextAction(base())).toMatchObject({ tone: 'clear', title: 'No hay nada urgente ahora', href: '/opportunities' });
  });
  it('respeta los permisos: no manda a donde la persona no puede entrar', () => {
    const none = { tasks: false, inbox: false, customers: false, opportunities: false };
    expect(nextAction(base({ overdue: [{ title: 'x', customerId: null }], pendingReplies: 2, firstPending: { id: 'v', name: 'B' }, can: none }))).toMatchObject({ tone: 'clear', href: null, cta: null });
    expect(nextAction(base({ overdue: [{ title: 'x', customerId: null }], can: { ...none, inbox: true }, pendingReplies: 2, firstPending: { id: 'v', name: 'B' } })).title).toBe('Responde a B');
  });
});

describe('tiempos relativos', () => {
  const now = new Date('2026-09-20T15:00:00Z');
  const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
  it('ahora · minutos · horas · ayer · fecha', () => {
    expect(timeAgo(ago(20), now)).toBe('ahora'); expect(timeAgo(ago(300), now)).toBe('hace 5 min'); expect(timeAgo(ago(7300), now)).toBe('hace 2 h'); expect(timeAgo(ago(100000), now)).toBe('ayer');
    expect(timeAgo(ago(400000), now, 'es', 'UTC')).toMatch(/\d+ sept/);
  });
  it('valores vacíos o inválidos no rompen', () => { expect(timeAgo(null, now)).toBe(''); expect(timeAgo('no-es-fecha', now)).toBe(''); expect(timeAgo(ago(-500), now)).toBe('ahora'); });
});
