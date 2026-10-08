import type { ServerSupabase } from '@/lib/supabase/server';
import { parseDashFilters, personTeamMatcher, previousPeriod, resolveDateRange, type DateRange } from '@/lib/analytics';
import { listMembers } from '@/repositories/members';
import { listTeams } from '@/repositories/teams';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Lo que comparten todas las pestañas de Analítica y su exportación a CSV: los filtros globales ya leídos,
 * el rango de fechas (y el anterior, para comparar), las personas y equipos, y el filtro por dueño.
 * Antes cada página armaba esto por su cuenta (y la exportación ignoraba personas y equipos). */
export async function loadAnalyticsScope(db: ServerSupabase, org: { orgId: string; orgTimezone: string }, sp: SP | URLSearchParams, now = new Date()) {
  const get = (k: string) => (sp instanceof URLSearchParams ? (sp.getAll(k).length > 1 ? sp.getAll(k) : sp.get(k) ?? undefined) : sp[k]);
  const filters = parseDashFilters({ periodo: one(get('periodo')), desde: one(get('desde')), hasta: one(get('hasta')), personas: get('personas'), equipos: get('equipos'), canal: one(get('canal')) });
  const range: DateRange = resolveDateRange(filters.periodo, now, org.orgTimezone, { from: filters.desde, to: filters.hasta });
  const prevRange = previousPeriod(range);
  const [members, teams] = await Promise.all([listMembers(db, org.orgId), listTeams(db, org.orgId)]);
  const active = members.filter((m) => m.status === 'active');
  const teamOf = new Map(active.map((m) => [m.userId, m.teamId]));
  const nameOf = (id: string | null) => (id ? (active.find((m) => m.userId === id)?.fullName ?? active.find((m) => m.userId === id)?.email ?? 'Sin nombre') : 'Sin asignar');
  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? 'Sin equipo';
  const regionOf = (id: string | null) => teams.find((t) => t.id === id)?.region || 'Sin región';
  const matches = personTeamMatcher(filters, teamOf);
  /** Las personas que pasan los filtros (para las tablas «por persona»). */
  const people = active.filter((m) => (filters.personas.length === 0 || filters.personas.includes(m.userId)) && (filters.equipos.length === 0 || filters.equipos.includes(m.teamId ?? '')));
  return { filters, range, prevRange, members, active, teams, teamOf, nameOf, teamName, regionOf, matches, people };
}
export type AnalyticsScope = Awaited<ReturnType<typeof loadAnalyticsScope>>;
