import type { ServerSupabase } from '@/lib/supabase/server';
import {
  filterWidgetFacts, previousPeriod, resolveDateRange,
  type DateRange, type WidgetDimension, type WidgetFilters, type WidgetLeadFact,
} from '@/lib/analytics';
import { listMembers } from '@/repositories/members';
import { listTeams } from '@/repositories/teams';
import { listWidgetLeadFacts, WIDGET_FACTS_LIMIT } from '@/repositories/widget-metrics';

export interface WidgetMetricsData {
  /** Leads del período actual que ya pasaron los filtros (los globales y los propios del widget). */
  facts: WidgetLeadFact[];
  /** Leads del período de comparación anterior, con los mismos filtros — para las flechas de variación. */
  previous: WidgetLeadFact[];
  /** Leads del período actual con solo los filtros globales (personas/equipos): de aquí salen las opciones
   * de los selectores (widget/página/producto/campaña/región), para que no desaparezcan al elegir una. */
  all: WidgetLeadFact[];
  /** true si había más de `WIDGET_FACTS_LIMIT` leads en el período y se recortó a los más recientes. */
  truncated: boolean;
  range: DateRange;
  /** Nombre legible de la clave de una dimensión (`asesor`/`equipo` por id; el resto ya es texto). */
  labelOf: (d: WidgetDimension) => (key: string) => string;
}

/** Todo lo que necesita la pestaña «Widget» de Analítica: los hechos del período (y del anterior, para
 * comparar), ya filtrados, más los nombres de personas y equipos para mostrarlos en los desgloses. */
export async function loadWidgetMetrics(
  db: ServerSupabase,
  org: { orgId: string; orgTimezone: string },
  filters: WidgetFilters,
): Promise<WidgetMetricsData> {
  const range = resolveDateRange(filters.periodo, new Date(), org.orgTimezone, { from: filters.desde, to: filters.hasta });
  const prevRange = previousPeriod(range);

  const [{ facts: rawCurrent, truncated }, { facts: rawPrevious }, members, teams] = await Promise.all([
    listWidgetLeadFacts(db, org.orgId, range.from, range.to, WIDGET_FACTS_LIMIT),
    listWidgetLeadFacts(db, org.orgId, prevRange.from, prevRange.to, WIDGET_FACTS_LIMIT),
    listMembers(db, org.orgId),
    listTeams(db, org.orgId),
  ]);

  const globalOnly: WidgetFilters = { ...filters, widget: undefined, pagina: undefined, producto: undefined, campana: undefined, region: undefined };
  const all = filterWidgetFacts(rawCurrent, globalOnly);
  const facts = filterWidgetFacts(rawCurrent, filters);
  const previous = filterWidgetFacts(rawPrevious, filters);

  const memberName = new Map(members.map((m) => [m.userId, m.fullName || m.email || 'Sin nombre']));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  // El nombre del widget ya viaja en cada hecho (lo resolvió la función de la base de datos); si el widget se
  // borró, usamos el último nombre visto en los propios leads en lugar de «Widget desconocido» siempre.
  const widgetName = new Map<string, string>();
  for (const f of rawCurrent) if (f.widgetId && f.widgetName) widgetName.set(f.widgetId, f.widgetName);

  const labelOf = (d: WidgetDimension) => (key: string): string => {
    if (d === 'asesor') return memberName.get(key) ?? 'Sin nombre';
    if (d === 'equipo') return teamName.get(key) ?? 'Sin equipo';
    if (d === 'widget') return widgetName.get(key) ?? 'Widget eliminado';
    return key; // pagina / producto / campana / region: la clave ya es el texto legible.
  };

  return { facts, previous, all, truncated, range, labelOf };
}
