import { TASK_TYPE_ICON, TASK_TYPE_LABEL, TASK_TYPES } from './tasks';

export const AUTOMATION_TRIGGERS = ['lead.created', 'opportunity.won', 'opportunity.lost', 'opportunity.stage_changed', 'activity.logged', 'task.completed'] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];
export const TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  'lead.created': 'Se crea un lead', 'opportunity.won': 'Se gana una oportunidad', 'opportunity.lost': 'Se pierde una oportunidad',
  'opportunity.stage_changed': 'Una oportunidad cambia de etapa', 'activity.logged': 'Se registra una actividad', 'task.completed': 'Se completa una tarea',
};
/** Campos del evento disponibles para condiciones, por disparador (coinciden con lo que ya emite el sistema). */
export const TRIGGER_FIELDS: Record<AutomationTrigger, { field: string; label: string; kind: 'text' | 'number' }[]> = {
  'lead.created': [{ field: 'source', label: 'Fuente', kind: 'text' }, { field: 'channel', label: 'Canal', kind: 'text' }],
  'opportunity.won': [{ field: 'amount', label: 'Monto', kind: 'number' }],
  'opportunity.lost': [{ field: 'amount', label: 'Monto', kind: 'number' }, { field: 'reason', label: 'Motivo', kind: 'text' }],
  'opportunity.stage_changed': [{ field: 'to', label: 'Etapa nueva', kind: 'text' }, { field: 'amount', label: 'Monto', kind: 'number' }],
  'activity.logged': [{ field: 'type', label: 'Tipo', kind: 'text' }, { field: 'direction', label: 'Dirección', kind: 'text' }],
  'task.completed': [{ field: 'title', label: 'Título', kind: 'text' }],
};

export const CONDITION_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
export const CONDITION_OP_LABEL: Record<ConditionOp, string> = { eq: 'es igual a', ne: 'es distinto de', gt: 'es mayor que', gte: 'es mayor o igual que', lt: 'es menor que', lte: 'es menor o igual que' };

export const AUTOMATION_ACTIONS = ['create_task', 'add_tag', 'assign_owner', 'enroll_sequence'] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];
export const ACTION_LABEL: Record<AutomationAction, string> = {
  create_task: 'Crear una tarea', add_tag: 'Agregar una etiqueta', assign_owner: 'Asignar un responsable', enroll_sequence: 'Inscribir en una secuencia',
};
export { TASK_TYPE_ICON, TASK_TYPE_LABEL, TASK_TYPES };

export type RunStatus = 'ok' | 'skipped' | 'failed';
export const RUN_STATUS_LABEL: Record<RunStatus, string> = { ok: 'Ejecutada', skipped: 'Omitida', failed: 'Falló' };
export const RUN_STATUS_BADGE: Record<RunStatus, string> = { ok: 'badge-ok', skipped: 'badge-neutral', failed: 'badge-danger' };

export interface RuleCondition { field: string; op: ConditionOp; value: string }
export interface RuleAction { type: AutomationAction; [key: string]: unknown }

/** Texto legible de una condición, para mostrarla en la lista sin que la persona lea JSON. */
export function describeCondition(c: RuleCondition): string {
  return `${c.field} ${CONDITION_OP_LABEL[c.op] ?? c.op} «${c.value}»`;
}
/** Texto legible de una acción. */
export function describeAction(a: RuleAction): string {
  switch (a.type) {
    case 'create_task': return `Crear tarea «${a.title as string}»`;
    case 'add_tag': return `Agregar la etiqueta «${a.name as string}»`;
    case 'assign_owner': return 'Asignar un responsable';
    case 'enroll_sequence': return 'Inscribir en una secuencia';
    default: return String(a.type);
  }
}
