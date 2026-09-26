import { TASK_TYPE_ICON, TASK_TYPE_LABEL, TASK_TYPES } from './tasks';

/** Una secuencia reutiliza los mismos tipos e iconos que una tarea: cada paso ES, en el fondo, una tarea. */
export const SEQUENCE_STEP_TYPES = TASK_TYPES;
export const SEQUENCE_STEP_TYPE_LABEL = TASK_TYPE_LABEL;
export const SEQUENCE_STEP_TYPE_ICON = TASK_TYPE_ICON;

export type EnrollmentStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export const ENROLLMENT_STATUS_LABEL: Record<EnrollmentStatus, string> = {
  active: 'Activa', paused: 'Pausada', completed: 'Completada', cancelled: 'Cancelada',
};
/** Un estado = un color, igual que en Tareas y Leads. */
export const ENROLLMENT_STATUS_BADGE: Record<EnrollmentStatus, string> = {
  active: 'badge-info', paused: 'badge-warn', completed: 'badge-ok', cancelled: 'badge-danger',
};

/** «Día 0», «Día 2», «Día 5»: cómo se explica el momento de un paso en la plantilla. */
export function offsetLabel(days: number): string {
  return days === 0 ? 'El mismo día' : days === 1 ? '1 día después' : `${days} días después`;
}
