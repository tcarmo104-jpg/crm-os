import { dayKey, daysBetween } from './time';

export type DueBucket = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'none';

export const BUCKET_ORDER: DueBucket[] = ['overdue', 'today', 'tomorrow', 'week', 'later', 'none'];
export const BUCKET_LABEL: Record<DueBucket, string> = {
  overdue: 'Vencidas', today: 'Hoy', tomorrow: 'Mañana', week: 'Esta semana', later: 'Más adelante', none: 'Sin fecha',
};

/**
 * En qué grupo cae una tarea abierta según su vencimiento, calculado en la ZONA DE LA ORGANIZACIÓN
 * (a las 8 p. m. en Bogotá ya es «mañana» en UTC; no debe verse como de otro día).
 * "Vencida" = pasó su hora de hoy o es de un día anterior.
 */
export function dueBucket(dueAt: string | null, now: Date, tz: string): DueBucket {
  if (!dueAt) return 'none';
  const due = new Date(dueAt);
  if (due.getTime() < now.getTime()) return 'overdue';
  const d = daysBetween(dayKey(now, tz), dayKey(due, tz));
  if (d <= 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d <= 7) return 'week';
  return 'later';
}

export function groupTasks<T extends { dueAt: string | null }>(tasks: T[], now: Date, tz: string): { bucket: DueBucket; tasks: T[] }[] {
  const map = new Map<DueBucket, T[]>();
  for (const t of tasks) {
    const b = dueBucket(t.dueAt, now, tz);
    map.set(b, [...(map.get(b) ?? []), t]);
  }
  return BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({
    bucket: b,
    tasks: (map.get(b) ?? []).slice().sort((x, y) => (x.dueAt ?? '').localeCompare(y.dueAt ?? '')),
  }));
}

export const TASK_TYPE_LABEL: Record<string, string> = {
  call: 'Llamada', whatsapp: 'WhatsApp', email: 'Correo', meeting: 'Reunión', follow_up: 'Seguimiento', other: 'Otra',
};
export const PRIORITY_LABEL: Record<string, string> = { low: 'Baja', normal: 'Normal', high: 'Alta' };
/** Tipos que implican contactar al cliente (para avisar si pidió no ser contactado). */
export const CONTACT_TASK_TYPES = ['call', 'whatsapp', 'email'];
