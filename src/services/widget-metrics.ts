import type { ServerSupabase } from '@/lib/supabase/server';
import {
  filterWidgetFacts, previousPeriod, resolveDateRange, widgetKeyOf,
  type DateRange, type WidgetDimension, type WidgetFilters, type WidgetLeadFact,
} from '@/lib/analytics';
import { listWidgetLeadFacts } from '@/repositories/widget-metrics';
import { listMembers } from '@/repositories/members';
import { listTeams } from '@/repositories/teams';

export interface WidgetMetricsData {
  range: DateRange;
  /** Todos los leads del widget del período (para armar las opciones de los filtros). */
  all: WidgetLeadFact[];
  /** Los que pasan los filtros. */
  facts: WidgetLeadFact[];
  /** Mismos filtros, período anterior del mismo tamaño (para comparar). */
  previous: WidgetLeadFact[];
  truncated: boolean;
  people: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  labelOf: (d: WidgetDimension) => (key: string) => string;
}

/** Arma todo lo que necesitan la página de métricas del widget y su exportación a CSV (la misma fuente, los
 * mismos filtros: lo que se descarga es exactamente lo que se ve). */
export async function loadWidgetMetrics(db: ServerSupabase, org: { orgId: string; orgTimezone: string }, filters: WidgetFilters, now = new Date()): Promise<WidgetMetricsData> {
  const range = resolveDateRange(filters.periodo, now, org.orgTimezone, { from: filters.desde, to: filters.hasta });
  const prevRange = previousPeriod(range);
  const [cur, prev, members, teams] = await Promise.all([
    listWidgetLeadFacts(db, { orgId: org.orgId, from: range.from, to: range.to }),
    listWidgetLeadFacts(db, { orgId: org.orgId, from: prevRange.from, to: prevRange.to }),
    listMembers(db, org.orgId),
    listTeams(db, org.orgId),
  ]);

  const memberName = new Map(members.map((m) => [m.userId, m.fullName || m.email || 'Sin nombre']));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  // El nombre del widget viene guardado en cada lead (no hace falta poder leer la configuración de widgets).
  const widgetName = new Map<string, string>();
  for (const f of [...cur.items].reverse()) if (f.widgetId && f.widgetName) widgetName.set(f.widgetId, f.widgetName);

  const labelOf = (d: WidgetDimension) => (key: string): string => {
    if (d === 'asesor') return memberName.get(key) ?? 'Persona que ya no está';
    if (d === 'equipo') return teamName.get(key) ?? 'Equipo eliminado';
    if (d === 'widget') return widgetName.get(key) ?? 'Widget eliminado';
    if (d === 'region' || d === 'campana') {
      // Se escribe a mano: se muestra como aparece la primera vez.
      return cur.items.map((f) => widgetKeyOf(f, d)).find((k) => k?.toLowerCase() === key.toLowerCase()) ?? key;
    }
    return key;
  };

  const active = members.filter((m) => m.status === 'active');
  return {
    range, all: cur.items, facts: filterWidgetFacts(cur.items, filters), previous: filterWidgetFacts(prev.items, filters), truncated: cur.truncated,
    people: active.map((m) => ({ id: m.userId, name: memberName.get(m.userId)! })),
    teams: teams.map((t) => ({ id: t.id, name: t.name })),
    labelOf,
  };
}
