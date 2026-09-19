import { describe, expect, it } from 'vitest';
import { dueBucket, groupTasks } from './tasks';

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
