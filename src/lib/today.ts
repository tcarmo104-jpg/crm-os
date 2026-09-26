import type { BoardCard } from './kanban';
import type { StageRow } from './types';

/** Lógica pura de la portada «Hoy»: qué mostrar y en qué orden (sin red ni base de datos). */
export interface FunnelRow { id: string; name: string; count: number; amount: number; /** 0–100, relativo a la etapa con más valor */ pct: number }

/** Valor y cantidad de oportunidades ABIERTAS por etapa, en el orden del embudo. */
export function stageFunnel(stages: StageRow[], cards: BoardCard[]): FunnelRow[] {
  const open = stages.filter((s) => s.kind === 'open' && !s.archivedAt).sort((a, b) => a.position - b.position);
  const rows = open.map((s) => {
    const mine = cards.filter((c) => c.stageId === s.id && c.status === 'open');
    return { id: s.id, name: s.name, count: mine.length, amount: mine.reduce((t, c) => t + (Number.isFinite(c.amount) ? c.amount : 0), 0), pct: 0 };
  });
  const max = Math.max(0, ...rows.map((r) => r.amount));
  const maxCount = Math.max(0, ...rows.map((r) => r.count));
  return rows.map((r) => ({ ...r, pct: max > 0 ? Math.round((r.amount / max) * 100) : maxCount > 0 ? Math.round((r.count / maxCount) * 100) : 0 }));
}

export interface NextActionInput {
  overdue: { title: string; customerId: string | null }[];
  today: { title: string; customerId: string | null }[];
  pendingReplies: number;
  firstPending: { id: string; name: string } | null;
  customerCount: number;
  openOpportunities: number;
  can: { tasks: boolean; inbox: boolean; customers: boolean; opportunities: boolean };
}
export interface NextAction { tone: 'urgent' | 'todo' | 'clear'; eyebrow: string; title: string; detail: string; href: string | null; cta: string | null }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Lo primero que la persona debe hacer AHORA: atrasos, luego respuestas pendientes, luego lo de hoy, luego empezar. */
export function nextAction(i: NextActionInput): NextAction {
  if (i.can.tasks && i.overdue.length > 0) {
    const t = i.overdue[0]!;
    return { tone: 'urgent', eyebrow: 'Atrasada', title: t.title, detail: `Tienes ${plural(i.overdue.length, 'tarea vencida', 'tareas vencidas')}. Empieza por esta.`, href: t.customerId ? `/customers/${t.customerId}` : '/tasks', cta: 'Resolver ahora' };
  }
  if (i.can.inbox && i.pendingReplies > 0 && i.firstPending) {
    return { tone: 'urgent', eyebrow: 'Espera tu respuesta', title: `Responde a ${i.firstPending.name}`, detail: `Hay ${plural(i.pendingReplies, 'conversación esperando', 'conversaciones esperando')} tu respuesta.`, href: `/inbox?c=${i.firstPending.id}`, cta: 'Abrir conversación' };
  }
  if (i.can.tasks && i.today.length > 0) {
    const t = i.today[0]!;
    return { tone: 'todo', eyebrow: 'Para hoy', title: t.title, detail: `Tienes ${plural(i.today.length, 'tarea', 'tareas')} para hoy.`, href: t.customerId ? `/customers/${t.customerId}` : '/tasks', cta: 'Ver tarea' };
  }
  if (i.can.customers && i.customerCount === 0) return { tone: 'todo', eyebrow: 'Empieza aquí', title: 'Crea o importa tus primeros clientes', detail: 'Con clientes en el CRM podrás abrir oportunidades, cotizar y llevar cada conversación.', href: '/customers/new', cta: 'Crear un cliente' };
  if (i.can.opportunities && i.openOpportunities === 0) return { tone: 'todo', eyebrow: 'Siguiente paso', title: 'Abre tu primera oportunidad', detail: 'Una oportunidad es una posible venta: sigue su avance por etapas hasta cerrarla.', href: '/opportunities/new', cta: 'Nueva oportunidad' };
  return { tone: 'clear', eyebrow: 'Todo al día', title: 'No hay nada urgente ahora', detail: 'Buen momento para dar seguimiento a tus oportunidades abiertas.', href: i.can.opportunities ? '/opportunities' : null, cta: i.can.opportunities ? 'Ver oportunidades' : null };
}

/** «hace 5 min», «ayer», «12 sept». */
export function timeAgo(iso: string | null | undefined, now: Date = new Date(), locale = 'es', timeZone = 'UTC'): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  if (s < 60) return 'ahora';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  if (s < 172800) return 'ayer';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone }).format(new Date(t));
}

// ---------------------------------------------------------------------------
// «Mi próxima acción»: la fila de trabajo COMPLETA (no solo el primer ítem), para su propia pantalla.
// ---------------------------------------------------------------------------
export interface QueueItem {
  kind: 'task_overdue' | 'reply' | 'task_today';
  tone: 'urgent' | 'todo';
  id: string;
  title: string;
  detail: string;
  href: string;
  customerId: string | null;
  at: string | null; // fecha de vencimiento u hora del último mensaje, para ordenar dentro del mismo tipo
}
export interface QueueInput {
  overdueTasks: { id: string; title: string; customerId: string | null; dueAt: string | null }[];
  todayTasks: { id: string; title: string; customerId: string | null; dueAt: string | null }[];
  pendingReplies: { id: string; name: string; lastMessageAt: string | null }[];
}

/** Misma prioridad que ya usa la tarjeta de «Hoy» (atrasadas → respuestas → de hoy), pero con la fila
 * COMPLETA en vez de solo el primer ítem, y ordenada de más urgente a menos dentro de cada grupo. */
export function buildActionQueue(i: QueueInput): QueueItem[] {
  const byDate = (a: { at: string | null }, b: { at: string | null }) => (a.at ? new Date(a.at).getTime() : 0) - (b.at ? new Date(b.at).getTime() : 0);
  const overdue: QueueItem[] = i.overdueTasks.map((t) => ({ kind: 'task_overdue', tone: 'urgent', id: t.id, title: t.title, detail: 'Tarea vencida', href: t.customerId ? `/customers/${t.customerId}` : '/tasks', customerId: t.customerId, at: t.dueAt }));
  const replies: QueueItem[] = i.pendingReplies.map((c) => ({ kind: 'reply', tone: 'urgent', id: c.id, title: `Responde a ${c.name}`, detail: 'Conversación esperando respuesta', href: `/inbox?c=${c.id}`, customerId: null, at: c.lastMessageAt }));
  const today: QueueItem[] = i.todayTasks.map((t) => ({ kind: 'task_today', tone: 'todo', id: t.id, title: t.title, detail: 'Vence hoy', href: t.customerId ? `/customers/${t.customerId}` : '/tasks', customerId: t.customerId, at: t.dueAt }));
  return [...overdue.sort(byDate), ...replies.sort(byDate), ...today.sort(byDate)];
}
