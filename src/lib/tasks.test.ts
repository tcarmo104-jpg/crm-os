import { describe, expect, it } from 'vitest';
import { buildTaskColumns, dueBucket, groupTasks, isOverdue, STATUS_BADGE, STATUS_LABEL, TASK_TYPE_ICON, TASK_TYPE_LABEL, TASK_TYPES } from './tasks';

const TZ = 'America/Bogota';                      // UTC-5
const NOW = new Date('2026-09-19T15:00:00Z');       // 10:00 del 19 en Bogotá

describe('dueBucket (zona horaria de la organización)', () => {
  it('clasifica por día de calendario local', () => {
    expect(dueBucket(null, NOW, TZ)).toBe('none');
    expect(dueBucket('2026-09-19T14:00:00Z', NOW, TZ)).toBe('overdue');   // 09:00 de hoy, ya pasó
    expect(dueBucket('2026-09-19T20:00:00Z', NOW, TZ)).toBe('today');     // 15:00 de hoy
    expect(dueBucket('2026-09-20T15:00:00Z', NOW, TZ)).toBe('tomorrow');
    expect(dueBucket('2026-09-24T15:00:00Z', NOW, TZ)).toBe('week');
    expect(dueBucket('2026-10-30T15:00:00Z', NOW, TZ)).toBe('later');
    expect(dueBucket('2026-09-15T15:00:00Z', NOW, TZ)).toBe('overdue');
  });
  it('a las 8 p. m. en Bogotá (01:00 UTC del día siguiente) sigue siendo HOY, no mañana', () => {
    expect(dueBucket('2026-09-20T01:00:00Z', NOW, TZ)).toBe('today');
    expect(dueBucket('2026-09-20T01:00:00Z', NOW, 'UTC')).toBe('tomorrow');   // el error que se evita
  });
});

describe('groupTasks', () => {
  it('agrupa en orden y ordena por fecha dentro de cada grupo', () => {
    const t = (id: string, dueAt: string | null) => ({ id, dueAt });
    const g = groupTasks([t('a', '2026-09-21T15:00:00Z'), t('b', null), t('c', '2026-09-19T20:00:00Z'), t('d', '2026-09-10T15:00:00Z'), t('e', '2026-09-19T22:00:00Z')], NOW, TZ);
    expect(g.map((x) => x.bucket)).toEqual(['overdue', 'today', 'week', 'none']);
    expect(g.find((x) => x.bucket === 'today')!.tasks.map((x) => x.id)).toEqual(['c', 'e']);
  });
  it('sin tareas no hay grupos', () => expect(groupTasks([], NOW, TZ)).toEqual([]));
});

describe('isOverdue: «vencida» es visual, no un estado guardado', () => {
  const NOW2 = new Date('2026-09-19T15:00:00Z');
  it('abierta o en progreso con fecha pasada → vencida', () => {
    expect(isOverdue({ status: 'open', dueAt: '2026-09-19T10:00:00Z' }, NOW2)).toBe(true);
    expect(isOverdue({ status: 'in_progress', dueAt: '2026-09-19T10:00:00Z' }, NOW2)).toBe(true);
  });
  it('sin fecha, con fecha futura, o ya cerrada → no vencida', () => {
    expect(isOverdue({ status: 'open', dueAt: null }, NOW2)).toBe(false);
    expect(isOverdue({ status: 'open', dueAt: '2026-09-20T10:00:00Z' }, NOW2)).toBe(false);
    expect(isOverdue({ status: 'done', dueAt: '2026-09-19T10:00:00Z' }, NOW2)).toBe(false);
    expect(isOverdue({ status: 'cancelled', dueAt: '2026-09-19T10:00:00Z' }, NOW2)).toBe(false);
  });
});

describe('catálogos de Tareas: cada estado y cada tipo tiene etiqueta, y los tipos tienen icono', () => {
  it('4 estados con su color (un estado = un color)', () => {
    expect(STATUS_LABEL).toEqual({ open: 'Pendiente', in_progress: 'En progreso', done: 'Completada', cancelled: 'Cancelada' });
    expect(new Set(Object.values(STATUS_BADGE)).size).toBe(4);
  });
  it('todo tipo de TASK_TYPES tiene etiqueta e icono, incluida la nueva «Visita»', () => {
    for (const t of TASK_TYPES) { expect(TASK_TYPE_LABEL[t]).toBeTruthy(); expect(TASK_TYPE_ICON[t]).toBeTruthy(); }
    expect(TASK_TYPE_LABEL.visit).toBe('Visita'); expect(TASK_TYPE_ICON.visit).toBe('pin');
  });
});

describe('buildTaskColumns: agrupa en las 4 columnas del Kanban, en orden', () => {
  it('cada tarea cae en su columna; el orden es siempre Pendiente → En progreso → Completada → Cancelada', () => {
    const t = (id: string, status: string) => ({ id, status });
    const cols = buildTaskColumns([t('a', 'done'), t('b', 'open'), t('c', 'in_progress'), t('d', 'cancelled'), t('e', 'open')]);
    expect(cols.map((c) => c.status)).toEqual(['open', 'in_progress', 'done', 'cancelled']);
    expect(cols[0]!.tasks.map((x) => x.id)).toEqual(['b', 'e']);
    expect(cols[1]!.tasks.map((x) => x.id)).toEqual(['c']);
    expect(cols.every((c) => c.label)).toBe(true);
  });
  it('sin tareas, las 4 columnas existen igual, vacías', () => {
    expect(buildTaskColumns([]).every((c) => c.tasks.length === 0)).toBe(true);
  });
});
