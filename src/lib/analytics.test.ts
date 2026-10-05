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

// ---------------------------------------------------------------------------
// Widget de WhatsApp (Fase 4)
// ---------------------------------------------------------------------------
import { breakdownWidgetFacts, filterWidgetFacts, formatDuration, NONE_FILTER, pageKey, parseWidgetFilters, summarizeWidgetFacts, widgetFilterOptions, type WidgetLeadFact } from './analytics';

const T0 = '2026-10-01T15:00:00Z';
const plus = (min: number) => new Date(new Date(T0).getTime() + min * 60_000).toISOString();
const fact = (o: Partial<WidgetLeadFact> = {}): WidgetLeadFact => ({
  leadId: Math.random().toString(36).slice(2), receivedAt: T0, customerId: 'c', isNew: true,
  widgetId: 'w1', widgetName: 'Web Bogotá', pageUrl: 'https://arkos.com.co/sillas?utm_source=google', productUrl: null,
  utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'verano', region: 'Bogotá', ownerId: 'u1', teamId: 't1',
  firstInboundAt: null, firstResponseAt: null, closedAt: null, opportunityId: null, saleId: null, saleTotal: null, ...o,
});

describe('pageKey: la misma página con distintos UTMs es UNA sola página', () => {
  it('quita protocolo, www, query, ancla y la barra final', () => {
    expect(pageKey('https://www.Arkos.com.co/sillas/?utm_source=google&utm_campaign=x#top')).toBe('arkos.com.co/sillas');
    expect(pageKey('http://arkos.com.co/sillas')).toBe('arkos.com.co/sillas');
    expect(pageKey('arkos.com.co/sillas?a=1')).toBe('arkos.com.co/sillas');
  });
  it('vacío o ausente = sin página', () => { expect(pageKey('')).toBeNull(); expect(pageKey(null)).toBeNull(); expect(pageKey('   ')).toBeNull(); });
  it('la página de inicio queda como el dominio solo', () => { expect(pageKey('https://arkos.com.co/')).toBe('arkos.com.co'); });
});

describe('summarizeWidgetFacts: el embudo y los tiempos', () => {
  const facts = [
    // escribió a los 5 min, respuesta humana 10 min después, cerrada a las 2 h; oportunidad y venta
    fact({ firstInboundAt: plus(5), firstResponseAt: plus(15), closedAt: plus(125), opportunityId: 'o1', saleId: 's1', saleTotal: 1_000_000 }),
    // escribió, respuesta a los 30 min, sin cerrar; oportunidad sin venta; recurrente
    fact({ isNew: false, firstInboundAt: plus(1), firstResponseAt: plus(31), opportunityId: 'o2' }),
    // escribió pero nadie respondió
    fact({ firstInboundAt: plus(2) }),
    // llenó el formulario y nunca escribió
    fact(),
  ];
  const s = summarizeWidgetFacts(facts);
  it('cuenta iniciadas, las que llegaron a WhatsApp, nuevos y recurrentes', () => {
    expect(s).toMatchObject({ started: 4, reachedWhatsapp: 3, newContacts: 3, returning: 1 });
  });
  it('conversión a oportunidad y a venta, sobre las conversaciones iniciadas', () => {
    expect(s).toMatchObject({ opportunities: 2, sales: 1, salesAmount: 1_000_000, reachedRate: 75, oppRate: 50, saleRate: 25, oppToSaleRate: 50 });
  });
  it('tiempos: solo de las que tienen respuesta / cierre; las sin responder se cuentan aparte', () => {
    expect(s.answered).toBe(2); expect(s.unanswered).toBe(1);
    expect(s.avgFirstResponseMs).toBe(20 * 60_000);      // (10 + 30) / 2
    expect(s.medianFirstResponseMs).toBe(20 * 60_000);
    expect(s.resolved).toBe(1); expect(s.avgResolutionMs).toBe(120 * 60_000);
  });
  it('sin datos: tasas y tiempos nulos (nunca un 0% o «0 s» engañoso)', () => {
    expect(summarizeWidgetFacts([])).toMatchObject({ started: 0, reachedRate: null, oppRate: null, oppToSaleRate: null, avgFirstResponseMs: null, avgResolutionMs: null });
  });
  it('la mediana resiste un caso extremo que dispara el promedio', () => {
    const r = summarizeWidgetFacts([1, 2, 3].map((m) => fact({ firstInboundAt: plus(0), firstResponseAt: plus(m) })).concat(fact({ firstInboundAt: plus(0), firstResponseAt: plus(600) })));
    expect(r.medianFirstResponseMs).toBe(2.5 * 60_000);
    expect(r.avgFirstResponseMs!).toBeGreaterThan(100 * 60_000);
  });
});

describe('breakdownWidgetFacts: desglose por cualquier dimensión', () => {
  const facts = [
    fact({ pageUrl: 'https://arkos.com.co/sillas?utm_source=fb', utmCampaign: 'Verano', opportunityId: 'o1' }),
    fact({ pageUrl: 'https://arkos.com.co/sillas?utm_source=google', utmCampaign: 'verano' }),
    fact({ pageUrl: 'https://arkos.com.co/mesas', utmCampaign: null }),
  ];
  it('por página: agrupa ignorando los UTMs de la URL, de mayor a menor', () => {
    const rows = breakdownWidgetFacts(facts, 'pagina', (k) => k);
    expect(rows.map((r) => [r.label, r.summary.started, r.summary.opportunities])).toEqual([['arkos.com.co/sillas', 2, 1], ['arkos.com.co/mesas', 1, 0]]);
  });
  it('por campaña: «Verano» y «verano» son la misma; los que no tienen campaña van a «Sin campaña»', () => {
    const rows = breakdownWidgetFacts(facts, 'campana', (k) => k);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.summary.started).toBe(2);
    expect(rows[1]).toMatchObject({ key: NONE_FILTER, label: 'Sin campaña' });
  });
  it('por asesor: usa la etiqueta que se le pase (el nombre), y «Sin asignar» para los sin dueño', () => {
    const rows = breakdownWidgetFacts([fact({ ownerId: 'u1' }), fact({ ownerId: null })], 'asesor', (k) => (k === 'u1' ? 'Ana' : k));
    expect(rows.map((r) => r.label)).toEqual(['Ana', 'Sin asignar']);
  });
  it('las opciones de un filtro salen de lo que existe en el período', () => {
    expect(widgetFilterOptions(facts, 'region', (k) => k)).toEqual([{ value: 'Bogotá', label: 'Bogotá' }]);
  });
});

describe('parseWidgetFilters y filterWidgetFacts', () => {
  it('lee los filtros propios y los globales; «por» inválido vuelve a página', () => {
    const f = parseWidgetFilters({ periodo: 'last_30', personas: ['u1', 'u2'], equipos: 't1', widget: 'w1', campana: ' verano ', por: 'nada' });
    expect(f).toMatchObject({ periodo: 'last_30', personas: ['u1', 'u2'], equipos: ['t1'], widget: 'w1', campana: 'verano', por: 'pagina' });
    expect(parseWidgetFilters({ por: 'asesor' }).por).toBe('asesor');
  });
  const facts = [
    fact({ leadId: 'a', ownerId: 'u1', teamId: 't1', utmCampaign: 'verano', pageUrl: 'https://arkos.com.co/sillas?x=1' }),
    fact({ leadId: 'b', ownerId: 'u2', teamId: 't2', utmCampaign: null, widgetId: 'w2', region: 'Medellín', pageUrl: 'https://arkos.com.co/mesas' }),
  ];
  const ids = (f: Partial<ReturnType<typeof parseWidgetFilters>>) => filterWidgetFacts(facts, { ...parseWidgetFilters({}), ...f }).map((x) => x.leadId);
  it('sin filtros, todo', () => { expect(ids({})).toEqual(['a', 'b']); });
  it('por campaña (sin importar mayúsculas), y «sin campaña»', () => { expect(ids({ campana: 'VERANO' })).toEqual(['a']); expect(ids({ campana: NONE_FILTER })).toEqual(['b']); });
  it('por página: con la misma clave que el desglose (sin UTMs)', () => { expect(ids({ pagina: 'arkos.com.co/sillas' })).toEqual(['a']); });
  it('por asesor, equipo, widget y región', () => {
    expect(ids({ personas: ['u2'] })).toEqual(['b']); expect(ids({ equipos: ['t1'] })).toEqual(['a']);
    expect(ids({ widget: 'w2' })).toEqual(['b']); expect(ids({ region: 'medellín' })).toEqual(['b']);
  });
  it('los filtros se combinan (Y)', () => { expect(ids({ campana: 'verano', personas: ['u2'] })).toEqual([]); });
});

describe('formatDuration', () => {
  it('escala la unidad', () => {
    expect(formatDuration(null)).toBe('—'); expect(formatDuration(45_000)).toBe('45 s'); expect(formatDuration(12 * 60_000)).toBe('12 min');
    expect(formatDuration(185 * 60_000)).toBe('3 h 5 min'); expect(formatDuration(120 * 60_000)).toBe('2 h'); expect(formatDuration((52 * 60) * 60_000)).toBe('2 d 4 h');
  });
});
