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
  call: 'Llamada', whatsapp: 'WhatsApp', email: 'Correo', meeting: 'Reunión', visit: 'Visita', follow_up: 'Seguimiento', other: 'Otra',
};
/** Un icono por tipo, para reconocer la tarea de un vistazo (el color se reserva para el ESTADO). */
export const TASK_TYPE_ICON: Record<string, string> = {
  call: 'phone', whatsapp: 'chat', email: 'mail', meeting: 'users', visit: 'pin', follow_up: 'repeat', other: 'box',
};
export const TASK_TYPES = ['call', 'whatsapp', 'email', 'meeting', 'visit', 'follow_up', 'other'] as const;
export const PRIORITY_LABEL: Record<string, string> = { low: 'Baja', normal: 'Normal', high: 'Alta' };

import type { TaskStatus } from './types';
export type { TaskStatus };
/** «Pendiente / En progreso / Completada / Cancelada»: el estado real, guardado. */
export const STATUS_LABEL: Record<TaskStatus, string> = { open: 'Pendiente', in_progress: 'En progreso', done: 'Completada', cancelled: 'Cancelada' };
export const STATUS_BADGE: Record<TaskStatus, string> = { open: 'badge-neutral', in_progress: 'badge-info', done: 'badge-ok', cancelled: 'badge-danger' };
export const OPEN_STATUSES: TaskStatus[] = ['open', 'in_progress'];

/** «Vencida» no es un estado guardado: es una tarea abierta o en progreso cuya fecha ya pasó. Se muestra ENCIMA del estado real. */
export function isOverdue(t: { status: string; dueAt: string | null }, now: Date = new Date()): boolean {
  return OPEN_STATUSES.includes(t.status as TaskStatus) && !!t.dueAt && new Date(t.dueAt).getTime() < now.getTime();
}
/** Tipos que implican contactar al cliente (para avisar si pidió no ser contactado). */
export const CONTACT_TASK_TYPES = ['call', 'whatsapp', 'email'];

export interface TaskColumn { status: TaskStatus; label: string; tasks: { id: string }[] }
/** Agrupa tareas en las 4 columnas del Kanban, en el orden habitual del flujo. */
export function buildTaskColumns<T extends { status: string }>(tasks: T[]): { status: TaskStatus; label: string; tasks: T[] }[] {
  const order: TaskStatus[] = ['open', 'in_progress', 'done', 'cancelled'];
  return order.map((status) => ({ status, label: STATUS_LABEL[status], tasks: tasks.filter((t) => t.status === status) }));
}
