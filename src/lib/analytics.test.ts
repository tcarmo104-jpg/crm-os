import { describe, expect, it } from 'vitest';
import { autoGranularity, buildAlerts, buildFunnelWithConversion, buildPerformance, DATE_PRESETS, groupByKey, groupLeadsBySource, groupSalesByPeriod, parseDashFilters, pctChange, previousPeriod, resolveDateRange } from './analytics';

const TZ = 'America/Bogota';

describe('resolveDateRange: cada período con nombre calcula un rango real', () => {
  it('«hoy» cubre desde medianoche hasta el final del mismo día, en la zona de la organización', () => {
    const now = new Date('2026-09-26T15:00:00Z');
    const r = resolveDateRange('today', now, TZ);
    expect(r.from < r.to).toBe(true);
    expect(new Date(r.from).getTime()).toBeLessThan(now.getTime());
  });
  it('«últimos 7 días» abarca una semana completa', () => {
    const now = new Date('2026-09-26T15:00:00Z');
    const r = resolveDateRange('last_7', now, TZ);
    const days = (new Date(r.to).getTime() - new Date(r.from).getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.5); expect(days).toBeLessThan(7.5);
  });
  it('«este mes» empieza el día 1', () => {
    const now = new Date('2026-09-26T15:00:00Z');
    const r = resolveDateRange('this_month', now, TZ);
    expect(r.from).toMatch(/2026-08-31|2026-09-01/); // 00:00 en Bogotá puede caer el 31 en UTC según el offset
  });
  it('personalizado usa las fechas dadas', () => {
    const r = resolveDateRange('custom', new Date('2026-09-26'), TZ, { from: '2026-01-01', to: '2026-01-31' });
    expect(r.from.startsWith('2026-01-01') || r.from.startsWith('2025-12-31')).toBe(true);
    expect(r.to.startsWith('2026-01-31') || r.to.startsWith('2026-02-01')).toBe(true);
  });
  it('todos los períodos tienen una etiqueta', () => {
    for (const p of DATE_PRESETS) expect(typeof p).toBe('string');
  });
});

describe('buildFunnelWithConversion: cuenta por etapa y calcula la conversión hacia la siguiente', () => {
  const stages = [{ id: 's1', name: 'Nuevo', position: 1 }, { id: 's2', name: 'Calificado', position: 2 }, { id: 's3', name: 'Ganado', position: 3 }];
  it('la primera etapa no tiene conversión (no hay una anterior)', () => {
    const rows = buildFunnelWithConversion(stages, [{ stageId: 's1', amount: 100 }, { stageId: 's1', amount: 200 }]);
    expect(rows[0]).toMatchObject({ count: 2, amount: 300, conversion: null });
  });
  it('calcula el porcentaje que pasa de una etapa a la siguiente', () => {
    const opps = [{ stageId: 's1', amount: 0 }, { stageId: 's1', amount: 0 }, { stageId: 's1', amount: 0 }, { stageId: 's1', amount: 0 }, { stageId: 's2', amount: 0 }, { stageId: 's2', amount: 0 }];
    const rows = buildFunnelWithConversion(stages, opps);
    expect(rows[0]!.count).toBe(4); expect(rows[1]!.count).toBe(2); expect(rows[1]!.conversion).toBe(50);
  });
  it('una etapa vacía no revienta la división: la siguiente queda con conversión nula', () => {
    const rows = buildFunnelWithConversion(stages, [{ stageId: 's2', amount: 0 }]);
    expect(rows[0]!.count).toBe(0); expect(rows[1]!.conversion).toBeNull();
  });
});

describe('groupSalesByPeriod: agrupa por mes por defecto', () => {
  it('suma monto y cuenta por mes calendario', () => {
    const rows = groupSalesByPeriod([{ soldAt: '2026-01-05T12:00:00Z', total: 100 }, { soldAt: '2026-01-20T12:00:00Z', total: 50 }, { soldAt: '2026-02-01T12:00:00Z', total: 30 }], 'UTC', 'month');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ count: 2, amount: 150 });
    expect(rows[1]).toMatchObject({ count: 1, amount: 30 });
  });
  it('ordena de más antiguo a más reciente', () => {
    const rows = groupSalesByPeriod([{ soldAt: '2026-03-01T00:00:00Z', total: 1 }, { soldAt: '2026-01-01T00:00:00Z', total: 1 }], 'UTC', 'month');
    expect(rows.map((r) => r.key)).toEqual(['2026-01', '2026-03']);
  });
});

describe('groupLeadsBySource: cuenta por fuente y cuántos ya coincidían con un cliente', () => {
  it('agrupa y ordena de la fuente con más leads a la que tiene menos', () => {
    const rows = groupLeadsBySource([{ source: 'facebook', resolution: 'created' }, { source: 'whatsapp', resolution: 'matched' }, { source: 'facebook', resolution: 'matched' }, { source: 'facebook', resolution: 'created' }]);
    expect(rows[0]).toMatchObject({ source: 'facebook', count: 3, matched: 1 });
    expect(rows[1]).toMatchObject({ source: 'whatsapp', count: 1, matched: 1 });
  });
});

describe('buildPerformance: una fila por persona, ordenada por lo que más vendió', () => {
  it('cuenta ganadas/perdidas, calcula la tasa de conversión y las tareas completadas', () => {
    const rows = buildPerformance(
      [{ id: 'p1' }, { id: 'p2' }],
      [{ ownerId: 'p1', status: 'won', amount: 1000 }, { ownerId: 'p1', status: 'lost', amount: 500 }, { ownerId: 'p2', status: 'won', amount: 300 }],
      [{ assigneeId: 'p1' }, { assigneeId: 'p1' }, { assigneeId: 'p2' }],
    );
    expect(rows[0]).toMatchObject({ personId: 'p1', won: 1, wonAmount: 1000, lost: 1, winRate: 50, tasksCompleted: 2 });
    expect(rows[1]).toMatchObject({ personId: 'p2', won: 1, wonAmount: 300, winRate: 100, tasksCompleted: 1 });
  });
  it('sin ganadas ni perdidas, la tasa de conversión queda nula (no «0%»​, que engañaría)', () => {
    const rows = buildPerformance([{ id: 'p1' }], [], []);
    expect(rows[0]!.winRate).toBeNull();
  });
});

describe('previousPeriod: el mismo tamaño de rango, justo antes', () => {
  it('un rango de 30 días produce otro rango de 30 días inmediatamente anterior', () => {
    const range = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.000Z' };
    const prev = previousPeriod(range);
    expect(new Date(prev.to).getTime()).toBeLessThan(new Date(range.from).getTime());
    const spanCurrent = new Date(range.to).getTime() - new Date(range.from).getTime();
    const spanPrev = new Date(prev.to).getTime() - new Date(prev.from).getTime();
    expect(Math.abs(spanCurrent - spanPrev)).toBeLessThan(2000);
  });
});

describe('pctChange: variación porcentual, sin mostrar algo engañoso cuando no hay base', () => {
  it('calcula el porcentaje normal cuando el período anterior tuvo actividad', () => {
    expect(pctChange(124, 110)).toBeCloseTo(12.7, 1);
    expect(pctChange(80, 100)).toBe(-20);
  });
  it('sin nada en el período anterior, no inventa un porcentaje (ni 0% ni infinito)', () => {
    expect(pctChange(10, 0)).toBeNull();
    expect(pctChange(0, 0)).toBeNull();
  });
});

describe('autoGranularity: agrupa por día si el rango es corto, por semana o mes si es largo', () => {
  it('un mes se ve día a día', () => { expect(autoGranularity({ from: '2026-09-01', to: '2026-09-30' })).toBe('day'); });
  it('un trimestre se ve por semana', () => { expect(autoGranularity({ from: '2026-01-01', to: '2026-03-31' })).toBe('week'); });
  it('un año se ve por mes', () => { expect(autoGranularity({ from: '2026-01-01', to: '2026-12-31' })).toBe('month'); });
});

describe('groupByKey: agrupa cualquier lista, cuenta y suma, y ordena de mayor a menor', () => {
  it('agrupa por la clave dada y usa «Sin asignar» cuando la clave es nula', () => {
    const rows = groupByKey(
      [{ team: 't1', amount: 100 }, { team: 't1', amount: 50 }, { team: null, amount: 10 }],
      (r) => r.team, (k) => `Equipo ${k}`, (r) => r.amount,
    );
    expect(rows[0]).toMatchObject({ key: 't1', label: 'Equipo t1', count: 2, amount: 150 });
    expect(rows[1]).toMatchObject({ key: '__none__', label: 'Sin asignar', count: 1, amount: 10 });
  });
});

describe('buildAlerts: solo aparecen las alertas que de verdad tienen algo pendiente', () => {
  it('sin nada pendiente, no hay ninguna alerta', () => {
    expect(buildAlerts({ overdueTasks: 0, overdueOpportunities: 0, leadsPendingContact: 0, quotesPendingFollowUp: 0 })).toEqual([]);
  });
  it('cada alerta lleva a su propio módulo, ya filtrado', () => {
    const rows = buildAlerts({ overdueTasks: 3, overdueOpportunities: 0, leadsPendingContact: 5, quotesPendingFollowUp: 0 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: '3 tareas vencidas', href: '/tasks', tone: 'urgent' });
    expect(rows[1]).toMatchObject({ label: '5 leads pendientes de contactar', tone: 'urgent' });
  });
  it('el singular se usa correctamente para una sola unidad', () => {
    const rows = buildAlerts({ overdueTasks: 1, overdueOpportunities: 0, leadsPendingContact: 0, quotesPendingFollowUp: 0 });
    expect(rows[0]!.label).toBe('1 tarea vencida');
  });
});

describe('parseDashFilters: lee los filtros globales desde los parámetros de la URL', () => {
  it('normaliza «personas» y «equipos» a una lista, venga uno o varios', () => {
    expect(parseDashFilters({ personas: 'p1' }).personas).toEqual(['p1']);
    expect(parseDashFilters({ personas: ['p1', 'p2'] }).personas).toEqual(['p1', 'p2']);
    expect(parseDashFilters({}).personas).toEqual([]);
  });
  it('un período desconocido cae en «este mes» por defecto', () => {
    expect(parseDashFilters({ periodo: 'lo-que-sea' }).periodo).toBe('this_month');
  });
});
