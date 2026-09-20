import { describe, expect, it } from 'vitest';
import {
  avatarHue, initials, EMPTY_KANBAN, activeFilterCount, applyMove, buildColumns, closeRange, createdFrom, dropOutcome, isOverdue, kanbanHref, kpis, parseKanbanQuery, sortCards,
  type BoardCard,
} from './kanban';
import type { StageRow } from './types';

const ID = '11111111-1111-4111-8111-111111111111';
const stage = (id: string, name: string, kind: StageRow['kind'], position: number, archivedAt: string | null = null): StageRow =>
  ({ id, pipelineId: 'p', name, kind, position, probability: 10, archivedAt });
const STAGES = [stage('s5', 'Negociación', 'open', 50), stage('lost', 'Perdida', 'lost', 10), stage('s1', 'Nueva', 'open', 10), stage('won', 'Ganada', 'won', 10),
  stage('s2', 'Contactado', 'open', 20), stage('old', 'Vieja', 'open', 15, '2026-01-01')];
const card = (o: Partial<BoardCard> & { id: string }): BoardCard => ({
  number: 'OPP-0001', title: 'Compra', amount: 100, currency: 'COP', stageId: 's1', status: 'open', priority: 'medium', temperature: null, channel: null,
  customerId: 'c1', customerName: 'Ana', ownerId: null, ownerName: null, createdAt: '2026-09-19T10:00:00Z', expectedCloseDate: null, product: null, conversationId: null, lostReason: null, ...o,
});

describe('filtros en la URL', () => {
  it('sin parámetros: todo vacío', () => expect(parseKanbanQuery({})).toEqual(EMPTY_KANBAN));
  it('lee cada filtro válido', () => {
    const q = parseKanbanQuery({ q: ' Ana  Ruiz ', asesor: ID, equipo: ID, region: 'Medellín', canal: 'whatsapp', producto: ID, etapa: ID, prioridad: 'high', temperatura: 'hot', creada: '7d', cierre: 'vencidas', min: '1.000.000', max: '5000000', pipeline: ID, o: ID, vista: 'lista' });
    expect(q).toMatchObject({ q: 'Ana Ruiz', asesor: ID, region: 'Medellín', canal: 'whatsapp', prioridad: 'high', temperatura: 'hot', creada: '7d', cierre: 'vencidas', min: '1000000', max: '5000000', o: ID, vista: 'lista' });
    expect(parseKanbanQuery({ asesor: 'none' }).asesor).toBe('none');
  });
  it('descarta todo lo inválido o malicioso', () => {
    const q = parseKanbanQuery({ asesor: '1; drop table x', equipo: 'x', producto: '../', etapa: 'no', canal: 'telegram', prioridad: 'urgente', temperatura: 'helada', creada: '999d', cierre: 'nunca', min: '-5', max: 'abc', pipeline: '<script>', o: 'javascript:alert(1)', vista: 'tabla' });
    expect(q).toEqual(EMPTY_KANBAN);
    expect(parseKanbanQuery({ q: 'x'.repeat(500) }).q).toHaveLength(80);
    expect(parseKanbanQuery({ prioridad: ['low', 'high'] }).prioridad).toBe('low');
  });
  it('los importes aceptan formatos habituales y rechazan negativos', () => {
    expect(parseKanbanQuery({ min: '2.500,50' }).min).toBe('2500.5');
    expect(parseKanbanQuery({ min: '0' }).min).toBe('0');
    expect(parseKanbanQuery({ min: '-1' }).min).toBe('');
  });
  it('ida y vuelta y omisión de vacíos', () => {
    expect(kanbanHref(EMPTY_KANBAN)).toBe('/opportunities');
    const q = parseKanbanQuery({ q: 'a&b', canal: 'email', o: ID });
    const href = kanbanHref(q);
    expect(href).toBe(`/opportunities?q=a%26b&canal=email&o=${ID}`);
    expect(parseKanbanQuery(Object.fromEntries(new URL(href, 'https://x.test').searchParams))).toEqual(q);
    expect(kanbanHref(q, { o: '', q: '' })).toBe('/opportunities?canal=email');
  });
  it('cuenta los filtros activos (mínimo y máximo cuentan como uno; búsqueda y tarjeta abierta, no)', () => {
    expect(activeFilterCount(EMPTY_KANBAN)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_KANBAN, q: 'x', o: ID, canal: 'web', min: '1', max: '2', prioridad: 'low' })).toBe(3);
  });
  it('rangos de fecha', () => {
    const now = new Date('2026-09-19T15:00:00Z');
    expect(createdFrom('', now)).toBeNull();
    expect(new Date(now).getTime() - new Date(createdFrom('30d', now)!).getTime()).toBe(30 * 86400000);
    expect(closeRange('', now)).toBeNull();
    expect(closeRange('vencidas', now)).toEqual({ to: '2026-09-18' });
    expect(closeRange('semana', now)).toEqual({ from: '2026-09-19', to: '2026-09-26' });
    expect(closeRange('mes', now)).toEqual({ from: '2026-09-19', to: '2026-10-19' });
    expect(closeRange('sin', now)).toEqual({ none: true });
  });
});

describe('columnas, totales e indicadores', () => {
  const cards = [
    card({ id: 'a', stageId: 's1', amount: 300 }), card({ id: 'b', stageId: 's1', amount: 700, createdAt: '2026-09-20T10:00:00Z' }),
    card({ id: 'c', stageId: 's2', amount: 50 }), card({ id: 'd', stageId: 'won', status: 'won', amount: 1000 }), card({ id: 'e', stageId: 'lost', status: 'lost', amount: 400 }),
  ];
  it('una columna por etapa visible, en orden abiertas → ganada → perdida, sin archivadas', () => {
    expect(buildColumns(STAGES, cards).map((c) => c.stage.name)).toEqual(['Nueva', 'Contactado', 'Negociación', 'Ganada', 'Perdida']);
  });
  it('cada columna cuenta y suma su valor (también las vacías)', () => {
    const cols = buildColumns(STAGES, cards);
    expect(cols.map((c) => [c.stage.name, c.count, c.amount])).toEqual([['Nueva', 2, 1000], ['Contactado', 1, 50], ['Negociación', 0, 0], ['Ganada', 1, 1000], ['Perdida', 1, 400]]);
  });
  it('las tarjetas de una etapa que no existe (archivada) no aparecen en ninguna columna ni suman', () => {
    const cols = buildColumns(STAGES, [card({ id: 'x', stageId: 'old', amount: 999 })]);
    expect(cols.reduce((n, c) => n + c.count, 0)).toBe(0);
  });
  it('orden por defecto: más reciente primero; cada columna puede ordenarse distinto', () => {
    expect(buildColumns(STAGES, cards)[0]!.cards.map((c) => c.id)).toEqual(['b', 'a']);
    expect(buildColumns(STAGES, cards, { s1: 'valor' })[0]!.cards.map((c) => c.id)).toEqual(['b', 'a']);
    expect(buildColumns(STAGES, cards, { s1: 'valor' })[1]!.cards.map((c) => c.id)).toEqual(['c']);
  });
  it('sortCards: valor, cierre (sin fecha al final), prioridad (alta primero, desempate por valor)', () => {
    const l = [card({ id: '1', amount: 10, expectedCloseDate: '2026-10-01', priority: 'low' }), card({ id: '2', amount: 20, expectedCloseDate: null, priority: 'high' }),
      card({ id: '3', amount: 30, expectedCloseDate: '2026-09-25', priority: 'high' })];
    expect(sortCards(l, 'valor').map((c) => c.id)).toEqual(['3', '2', '1']);
    expect(sortCards(l, 'cierre').map((c) => c.id)).toEqual(['3', '1', '2']);
    expect(sortCards(l, 'prioridad').map((c) => c.id)).toEqual(['3', '2', '1']);
    expect(l.map((c) => c.id)).toEqual(['1', '2', '3']);                       // no muta la lista original
  });
  it('indicadores: valor del pipeline solo de abiertas; ganadas y perdidas aparte', () => {
    expect(kpis(cards)).toEqual({ pipelineTotal: 1050, open: 3, won: 1, wonAmount: 1000, lost: 1, lostAmount: 400 });
    expect(kpis([])).toEqual({ pipelineTotal: 0, open: 0, won: 0, wonAmount: 0, lost: 0, lostAmount: 0 });
  });
});

describe('movimiento y reglas al soltar', () => {
  const [nueva, , , won, lost] = [STAGES[2]!, STAGES[4]!, STAGES[0]!, STAGES[3]!, STAGES[1]!];
  it('el movimiento optimista cambia etapa y estado sin tocar lo demás ni mutar', () => {
    const before = [card({ id: 'a' }), card({ id: 'b' })];
    const after = applyMove(before, 'a', won);
    expect(after[0]).toMatchObject({ stageId: 'won', status: 'won' });
    expect(after[1]).toBe(before[1]);
    expect(before[0]!.status).toBe('open');
    expect(applyMove(before, 'zzz', won)).toEqual(before);
  });
  it('misma columna = nada; entre abiertas = mover directo', () => {
    expect(dropOutcome({ from: nueva, to: nueva, canReopenClosed: false })).toEqual({ type: 'noop' });
    expect(dropOutcome({ from: nueva, to: STAGES[4]!, canReopenClosed: false })).toEqual({ type: 'move' });
  });
  it('a «Perdida» pide motivo; a «Ganada» pide confirmación', () => {
    expect(dropOutcome({ from: nueva, to: lost, canReopenClosed: false })).toEqual({ type: 'reason' });
    expect(dropOutcome({ from: nueva, to: won, canReopenClosed: false })).toEqual({ type: 'confirm_won' });
  });
  it('reabrir una cerrada solo lo puede hacer quien tiene alcance de organización', () => {
    expect(dropOutcome({ from: won, to: nueva, canReopenClosed: false })).toMatchObject({ type: 'blocked' });
    expect(dropOutcome({ from: lost, to: won, canReopenClosed: false })).toMatchObject({ type: 'blocked' });
    expect(dropOutcome({ from: won, to: nueva, canReopenClosed: true })).toEqual({ type: 'move' });
    expect(dropOutcome({ from: won, to: lost, canReopenClosed: true })).toEqual({ type: 'reason' });
  });
  it('vencida: solo abiertas con fecha anterior a hoy', () => {
    const now = new Date('2026-09-19T15:00:00Z');
    expect(isOverdue({ status: 'open', expectedCloseDate: '2026-09-18' }, now)).toBe(true);
    expect(isOverdue({ status: 'open', expectedCloseDate: '2026-09-19' }, now)).toBe(false);
    expect(isOverdue({ status: 'won', expectedCloseDate: '2026-01-01' }, now)).toBe(false);
    expect(isOverdue({ status: 'open', expectedCloseDate: null }, now)).toBe(false);
  });
});

describe('avatar del asesor', () => {
  it('iniciales: nombre y apellido, correo o vacío', () => {
    expect(initials('Natalia Moreno')).toBe('NM');
    expect(initials('  juan   carlos   pérez ')).toBe('JP');
    expect(initials('a@kb.test')).toBe('A');
    expect(initials('maria.lopez@x.com')).toBe('ML');
    expect(initials('')).toBe('?');
    expect(initials(null)).toBe('?');
  });
  it('el matiz es estable y está en 0–359', () => {
    expect(avatarHue('Natalia Moreno')).toBe(avatarHue('Natalia Moreno'));
    for (const n of ['a', 'Yeison', 'Laura Mejía', 'x'.repeat(200)]) { const h = avatarHue(n); expect(h).toBeGreaterThanOrEqual(0); expect(h).toBeLessThan(360); }
    expect(avatarHue('Ana')).not.toBe(avatarHue('Pedro'));
  });
});
