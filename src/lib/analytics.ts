import { zonedLocalToUtcIso } from './time';

// ---------------------------------------------------------------------------
// Rango de fechas: unos pocos períodos con nombre, más uno personalizado.
// ---------------------------------------------------------------------------
export const DATE_PRESETS = ['today', 'last_7', 'last_30', 'this_month', 'this_year', 'custom'] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];
export const DATE_PRESET_LABEL: Record<DatePreset, string> = {
  today: 'Hoy', last_7: 'Últimos 7 días', last_30: 'Últimos 30 días', this_month: 'Este mes', this_year: 'Este año', custom: 'Personalizado',
};
export interface DateRange { from: string; to: string }

/** Lee `?periodo=&desde=&hasta=` de la URL y devuelve un período válido (con reglas por defecto). */
export function parsePeriod(sp: { periodo?: string; desde?: string; hasta?: string }): { preset: DatePreset; desde?: string; hasta?: string } {
  const preset = (DATE_PRESETS as readonly string[]).includes(sp.periodo ?? '') ? (sp.periodo as DatePreset) : 'this_month';
  return { preset, desde: sp.desde, hasta: sp.hasta };
}

/** Lee los filtros globales del Dashboard (período + personas + equipos + canal) desde la URL. */
export function parseDashFilters(sp: { periodo?: string; desde?: string; hasta?: string; personas?: string | string[]; equipos?: string | string[]; canal?: string }) {
  const { preset, desde, hasta } = parsePeriod(sp);
  const toList = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean);
  return { periodo: preset, desde, hasta, personas: toList(sp.personas), equipos: toList(sp.equipos), canal: sp.canal || undefined };
}
export function resolveDateRange(preset: DatePreset, now: Date, tz: string, custom?: { from?: string; to?: string }): DateRange {
  const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [y, m] = todayLocal.split('-').map(Number) as [number, number];
  const startOfDay = (dateStr: string) => zonedLocalToUtcIso(`${dateStr}T00:00`, tz) ?? now.toISOString();
  const endOfDay = (dateStr: string) => zonedLocalToUtcIso(`${dateStr}T23:59`, tz) ?? now.toISOString();
  const daysAgo = (n: number) => { const d = new Date(now.getTime() - n * 86_400_000); return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d); };

  if (preset === 'today') return { from: startOfDay(todayLocal), to: endOfDay(todayLocal) };
  if (preset === 'last_7') return { from: startOfDay(daysAgo(6)), to: endOfDay(todayLocal) };
  if (preset === 'last_30') return { from: startOfDay(daysAgo(29)), to: endOfDay(todayLocal) };
  if (preset === 'this_month') return { from: startOfDay(`${y}-${String(m).padStart(2, '0')}-01`), to: endOfDay(todayLocal) };
  if (preset === 'this_year') return { from: startOfDay(`${y}-01-01`), to: endOfDay(todayLocal) };
  // custom
  const from = custom?.from ? startOfDay(custom.from) : startOfDay(daysAgo(29));
  const to = custom?.to ? endOfDay(custom.to) : endOfDay(todayLocal);
  return { from, to };
}

// ---------------------------------------------------------------------------
// Embudo con conversión: cuántas oportunidades hay en cada etapa, y qué tanto
// avanza de una etapa a la siguiente (una foto del momento, no del período).
// ---------------------------------------------------------------------------
export interface FunnelStageRow { id: string; name: string; count: number; amount: number; conversion: number | null }
export function buildFunnelWithConversion(stages: { id: string; name: string; position: number }[], opps: { stageId: string; amount: number }[]): FunnelStageRow[] {
  const ordered = [...stages].sort((a, b) => a.position - b.position);
  const rows = ordered.map((s) => {
    const mine = opps.filter((o) => o.stageId === s.id);
    return { id: s.id, name: s.name, count: mine.length, amount: mine.reduce((t, o) => t + o.amount, 0) };
  });
  return rows.map((r, i) => ({ ...r, conversion: i === 0 || rows[i - 1]!.count === 0 ? null : Math.round((r.count / rows[i - 1]!.count) * 100) }));
}

// ---------------------------------------------------------------------------
// Ventas por período: agrupa ventas por semana o por mes, según el tamaño del rango.
// ---------------------------------------------------------------------------
export interface PeriodBucket { key: string; label: string; count: number; amount: number }
export function groupSalesByPeriod(sales: { soldAt: string; total: number }[], tz: string, granularity: 'day' | 'week' | 'month' = 'month'): PeriodBucket[] {
  const buckets = new Map<string, PeriodBucket>();
  for (const s of sales) {
    const d = new Date(s.soldAt);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const [y, m, day] = parts.split('-');
    let key: string; let label: string;
    if (granularity === 'day') { key = parts; label = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', timeZone: tz }).format(d); }
    else if (granularity === 'week') {
      const weekStart = new Date(Date.UTC(+y!, +m! - 1, +day!)); weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
      key = weekStart.toISOString().slice(0, 10); label = `Semana del ${new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' }).format(weekStart)}`;
    } else { key = `${y}-${m}`; label = new Intl.DateTimeFormat('es', { month: 'long', year: 'numeric', timeZone: tz }).format(d); }
    const b = buckets.get(key) ?? { key, label, count: 0, amount: 0 };
    b.count += 1; b.amount += s.total; buckets.set(key, b);
  }
  return [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Leads por fuente: cuántos llegaron por cada fuente, y cuántos ya son clientes.
// ---------------------------------------------------------------------------
export interface SourceBucket { source: string; count: number; matched: number }
export function groupLeadsBySource(leads: { source: string; resolution: string }[]): SourceBucket[] {
  const buckets = new Map<string, SourceBucket>();
  for (const l of leads) {
    const b = buckets.get(l.source) ?? { source: l.source, count: 0, matched: 0 };
    b.count += 1; if (l.resolution === 'matched') b.matched += 1; buckets.set(l.source, b);
  }
  return [...buckets.values()].sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Desempeño: una fila por persona, con lo ganado/perdido y las tareas que completó.
// ---------------------------------------------------------------------------
export interface PerformanceRow { personId: string; won: number; wonAmount: number; lost: number; winRate: number | null; tasksCompleted: number }
export function buildPerformance(
  people: { id: string }[],
  opps: { ownerId: string | null; status: 'won' | 'lost'; amount: number }[],
  tasks: { assigneeId: string | null }[],
): PerformanceRow[] {
  return people.map((p) => {
    const mine = opps.filter((o) => o.ownerId === p.id);
    const won = mine.filter((o) => o.status === 'won');
    const lost = mine.filter((o) => o.status === 'lost');
    const total = won.length + lost.length;
    return {
      personId: p.id, won: won.length, wonAmount: won.reduce((t, o) => t + o.amount, 0), lost: lost.length,
      winRate: total === 0 ? null : Math.round((won.length / total) * 100),
      tasksCompleted: tasks.filter((t) => t.assigneeId === p.id).length,
    };
  }).sort((a, b) => b.wonAmount - a.wonAmount);
}

// ---------------------------------------------------------------------------
// Comparación contra el período anterior: mismo tamaño de rango, justo antes.
// ---------------------------------------------------------------------------
export function previousPeriod(range: DateRange): DateRange {
  const from = new Date(range.from).getTime(), to = new Date(range.to).getTime();
  const span = Math.max(to - from, 1);
  return { from: new Date(from - span).toISOString(), to: new Date(from - 1).toISOString() };
}
/** Variación porcentual entre el valor actual y el anterior. `null` si no hay con qué comparar (evita un «∞%» o un «0%» engañoso). */
export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? null : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Serie de tiempo genérica: cuenta y suma cualquier lista de registros con fecha,
// agrupados por día, semana o mes (reutilizada por leads, oportunidades y ventas).
// ---------------------------------------------------------------------------
export function buildTimeSeries(items: { at: string; amount?: number }[], tz: string, granularity: 'day' | 'week' | 'month'): PeriodBucket[] {
  return groupSalesByPeriod(items.map((i) => ({ soldAt: i.at, total: i.amount ?? 0 })), tz, granularity);
}
/** La granularidad razonable según cuántos días abarca el rango (evita una línea de 90 puntos por día). */
export function autoGranularity(range: DateRange): 'day' | 'week' | 'month' {
  const days = (new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000;
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

// ---------------------------------------------------------------------------
// Distribución por canal, por equipo/región: mismo patrón de conteo+monto que ya
// usa `groupLeadsBySource`, aplicado a cualquier campo de agrupación.
// ---------------------------------------------------------------------------
export interface GroupBucket { key: string; label: string; count: number; amount: number }
export function groupByKey<T>(items: T[], keyOf: (item: T) => string | null, labelOf: (key: string) => string, amountOf: (item: T) => number = () => 0): GroupBucket[] {
  const buckets = new Map<string, GroupBucket>();
  for (const item of items) {
    const key = keyOf(item) ?? '__none__';
    const b = buckets.get(key) ?? { key, label: key === '__none__' ? 'Sin asignar' : labelOf(key), count: 0, amount: 0 };
    b.count += 1; b.amount += amountOf(item); buckets.set(key, b);
  }
  return [...buckets.values()].sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Alertas: solo hechos objetivos ya presentes en el sistema, nunca inventados.
// ---------------------------------------------------------------------------
export interface AlertRow { key: string; label: string; count: number; href: string; tone: 'urgent' | 'todo' }
export function buildAlerts(counts: { overdueTasks: number; overdueOpportunities: number; leadsPendingContact: number; quotesPendingFollowUp: number }): AlertRow[] {
  const rows: AlertRow[] = [];
  if (counts.overdueTasks > 0) rows.push({ key: 'overdue_tasks', label: `${counts.overdueTasks} ${counts.overdueTasks === 1 ? 'tarea vencida' : 'tareas vencidas'}`, count: counts.overdueTasks, href: '/tasks', tone: 'urgent' });
  if (counts.leadsPendingContact > 0) rows.push({ key: 'leads_pending', label: `${counts.leadsPendingContact} ${counts.leadsPendingContact === 1 ? 'lead pendiente de contactar' : 'leads pendientes de contactar'}`, count: counts.leadsPendingContact, href: '/leads?estado=new', tone: 'urgent' });
  if (counts.overdueOpportunities > 0) rows.push({ key: 'overdue_opps', label: `${counts.overdueOpportunities} ${counts.overdueOpportunities === 1 ? 'oportunidad con fecha de cierre vencida' : 'oportunidades con fecha de cierre vencida'}`, count: counts.overdueOpportunities, href: '/opportunities', tone: 'todo' });
  if (counts.quotesPendingFollowUp > 0) rows.push({ key: 'quotes_pending', label: `${counts.quotesPendingFollowUp} ${counts.quotesPendingFollowUp === 1 ? 'cotización enviada sin seguimiento' : 'cotizaciones enviadas sin seguimiento'}`, count: counts.quotesPendingFollowUp, href: '/quotes', tone: 'todo' });
  return rows;
}
