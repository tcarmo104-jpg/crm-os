/**
 * Lógica pura del tablero de Oportunidades (sin red ni base de datos): filtros en la URL, columnas y totales,
 * indicadores, movimientos optimistas y qué debe pasar al soltar una tarjeta en cada columna.
 */
import { parseAmount } from './money';
import { orderedStages } from './pipeline';
import type { OpportunityStatus, StageRow } from './types';

export type Priority = 'high' | 'medium' | 'low';
export type Temperature = 'hot' | 'warm' | 'cold';
export const PRIORITIES: Priority[] = ['high', 'medium', 'low'];
export const TEMPERATURES: Temperature[] = ['hot', 'warm', 'cold'];
export const PRIORITY_LABEL: Record<Priority, string> = { high: 'Alta', medium: 'Media', low: 'Baja' };
export const TEMPERATURE_LABEL: Record<Temperature, string> = { hot: 'Caliente', warm: 'Tibia', cold: 'Fría' };
export const OPP_CHANNELS = ['whatsapp', 'instagram', 'facebook', 'email', 'phone', 'web', 'referral', 'other'] as const;
export type OppChannel = (typeof OPP_CHANNELS)[number];
export const OPP_CHANNEL_LABEL: Record<OppChannel, string> = {
  whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Messenger', email: 'Correo', phone: 'Llamada', web: 'Web', referral: 'Referido', other: 'Otro',
};
export const SORTS = [
  { key: 'recientes', label: 'Más recientes' }, { key: 'valor', label: 'Mayor valor' },
  { key: 'cierre', label: 'Cierre más cercano' }, { key: 'prioridad', label: 'Prioridad' },
] as const;
export type SortKey = (typeof SORTS)[number]['key'];

export const CREATED_OPTIONS = [{ key: 'hoy', label: 'Hoy' }, { key: '7d', label: 'Últimos 7 días' }, { key: '30d', label: 'Últimos 30 días' }, { key: '90d', label: 'Últimos 90 días' }] as const;
export const CLOSE_OPTIONS = [
  { key: 'vencidas', label: 'Vencidas' }, { key: 'semana', label: 'Próximos 7 días' }, { key: 'mes', label: 'Próximos 30 días' }, { key: 'sin', label: 'Sin fecha' },
] as const;

export interface KanbanQuery {
  q: string; asesor: string; equipo: string; region: string; canal: '' | OppChannel; producto: string; etapa: string;
  prioridad: '' | Priority; temperatura: '' | Temperature; creada: '' | (typeof CREATED_OPTIONS)[number]['key'];
  cierre: '' | (typeof CLOSE_OPTIONS)[number]['key']; min: string; max: string; pipeline: string; o: string; vista: '' | 'lista';
}
export const EMPTY_KANBAN: KanbanQuery = {
  q: '', asesor: '', equipo: '', region: '', canal: '', producto: '', etapa: '', prioridad: '', temperatura: '', creada: '', cierre: '', min: '', max: '', pipeline: '', o: '', vista: '',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Raw = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const uuid = (v: string) => (UUID.test(v) ? v : '');
const amount = (v: string) => { const n = v.trim() === '' ? null : parseAmount(v); return n !== null && n >= 0 ? String(n) : ''; };

/** Lee los filtros de la URL. Todo lo inválido se descarta: nada llega a la base de datos sin validar. */
export function parseKanbanQuery(sp: Raw): KanbanQuery {
  const asesor = one(sp.asesor);
  return {
    q: one(sp.q).replace(/\s+/g, ' ').trim().slice(0, 80),
    asesor: asesor === 'none' || UUID.test(asesor) ? asesor : '',
    equipo: uuid(one(sp.equipo)), producto: uuid(one(sp.producto)), etapa: uuid(one(sp.etapa)), pipeline: uuid(one(sp.pipeline)), o: uuid(one(sp.o)),
    region: one(sp.region).replace(/\s+/g, ' ').trim().slice(0, 60),
    canal: OPP_CHANNELS.find((c) => c === one(sp.canal)) ?? '',
    prioridad: PRIORITIES.find((p) => p === one(sp.prioridad)) ?? '',
    temperatura: TEMPERATURES.find((t) => t === one(sp.temperatura)) ?? '',
    creada: CREATED_OPTIONS.find((c) => c.key === one(sp.creada))?.key ?? '',
    cierre: CLOSE_OPTIONS.find((c) => c.key === one(sp.cierre))?.key ?? '',
    min: amount(one(sp.min)), max: amount(one(sp.max)), vista: one(sp.vista) === 'lista' ? 'lista' : '',
  };
}

/** Construye /opportunities?… omitiendo lo que está vacío. */
export function kanbanHref(base: KanbanQuery, overrides: Partial<KanbanQuery> = {}): string {
  const q = { ...base, ...overrides };
  const p = new URLSearchParams();
  for (const k of Object.keys(EMPTY_KANBAN) as (keyof KanbanQuery)[]) if (q[k]) p.set(k, q[k]);
  const s = p.toString();
  return s ? `/opportunities?${s}` : '/opportunities';
}

const FILTER_KEYS: (keyof KanbanQuery)[] = ['asesor', 'equipo', 'region', 'canal', 'producto', 'etapa', 'prioridad', 'temperatura', 'creada', 'cierre', 'min', 'max'];
export function activeFilterCount(q: KanbanQuery): number {
  const range = q.min || q.max ? 1 : 0;
  return FILTER_KEYS.filter((k) => k !== 'min' && k !== 'max' && q[k]).length + range;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
export function createdFrom(creada: KanbanQuery['creada'], now = new Date()): string | null {
  if (!creada) return null;
  const d = new Date(now);
  if (creada === 'hoy') d.setHours(0, 0, 0, 0);
  else d.setTime(d.getTime() - { '7d': 7, '30d': 30, '90d': 90 }[creada] * 86400000);
  return d.toISOString();
}
/** Rango de fechas de cierre estimado (yyyy-mm-dd). `none` = sin fecha. */
export function closeRange(cierre: KanbanQuery['cierre'], now = new Date()): { from?: string; to?: string; none?: boolean } | null {
  if (!cierre) return null;
  const today = iso(now);
  const plus = (n: number) => iso(new Date(now.getTime() + n * 86400000));
  if (cierre === 'sin') return { none: true };
  if (cierre === 'vencidas') return { to: iso(new Date(now.getTime() - 86400000)) };
  if (cierre === 'semana') return { from: today, to: plus(7) };
  return { from: today, to: plus(30) };
}

// ---------------------------------------------------------------------------- tarjetas y columnas
export interface BoardCard {
  id: string; number: string; title: string; amount: number; currency: string | null; stageId: string; status: OpportunityStatus;
  priority: Priority; temperature: Temperature | null; channel: OppChannel | null; customerId: string; customerName: string;
  ownerId: string | null; ownerName: string | null; createdAt: string; expectedCloseDate: string | null; product: string | null;
  conversationId: string | null; lostReason: string | null;
}
export interface BoardColumn { stage: StageRow; cards: BoardCard[]; count: number; amount: number }

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
export function sortCards(cards: BoardCard[], sort: SortKey): BoardCard[] {
  const by: Record<SortKey, (a: BoardCard, b: BoardCard) => number> = {
    recientes: (a, b) => b.createdAt.localeCompare(a.createdAt),
    valor: (a, b) => b.amount - a.amount,
    cierre: (a, b) => (a.expectedCloseDate ?? '9999-12-31').localeCompare(b.expectedCloseDate ?? '9999-12-31'),
    prioridad: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.amount - a.amount,
  };
  return [...cards].sort((a, b) => by[sort](a, b) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

/** Una columna por etapa (en el orden del pipeline), con su cantidad y su valor total. */
export function buildColumns(stages: StageRow[], cards: BoardCard[], sorts: Record<string, SortKey> = {}): BoardColumn[] {
  const byStage = new Map<string, BoardCard[]>();
  for (const c of cards) byStage.set(c.stageId, [...(byStage.get(c.stageId) ?? []), c]);
  return orderedStages(stages).map((stage) => {
    const list = sortCards(byStage.get(stage.id) ?? [], sorts[stage.id] ?? 'recientes');
    return { stage, cards: list, count: list.length, amount: list.reduce((n, c) => n + c.amount, 0) };
  });
}

export interface Kpis { pipelineTotal: number; open: number; won: number; wonAmount: number; lost: number; lostAmount: number }
export function kpis(cards: BoardCard[]): Kpis {
  const k: Kpis = { pipelineTotal: 0, open: 0, won: 0, wonAmount: 0, lost: 0, lostAmount: 0 };
  for (const c of cards) {
    if (c.status === 'open') { k.open++; k.pipelineTotal += c.amount; }
    else if (c.status === 'won') { k.won++; k.wonAmount += c.amount; }
    else { k.lost++; k.lostAmount += c.amount; }
  }
  return k;
}

/** Movimiento optimista: la tarjeta pasa de columna al instante (antes de que responda el servidor). */
export function applyMove(cards: BoardCard[], id: string, to: StageRow): BoardCard[] {
  return cards.map((c) => (c.id === id ? { ...c, stageId: to.id, status: to.kind } : c));
}

export type DropOutcome =
  | { type: 'noop' }
  | { type: 'move' }
  | { type: 'reason' }          // a «Perdida»: hay que pedir el motivo
  | { type: 'confirm_won' }     // a «Ganada»: pedir confirmación
  | { type: 'blocked'; message: string };

/** Qué hacer al soltar una tarjeta en una columna (las mismas reglas que la base de datos, para avisar antes). */
export function dropOutcome(p: { from: StageRow; to: StageRow; canReopenClosed: boolean }): DropOutcome {
  if (p.from.id === p.to.id) return { type: 'noop' };
  if (p.from.kind !== 'open' && !p.canReopenClosed) {
    return { type: 'blocked', message: 'Una oportunidad cerrada solo la puede reabrir un manager o administrador.' };
  }
  if (p.to.kind === 'lost') return { type: 'reason' };
  if (p.to.kind === 'won') return { type: 'confirm_won' };
  return { type: 'move' };
}

export function isOverdue(c: Pick<BoardCard, 'status' | 'expectedCloseDate'>, now = new Date()): boolean {
  return c.status === 'open' && c.expectedCloseDate !== null && c.expectedCloseDate < iso(now);
}

/** Iniciales para el avatar del asesor: «Natalia Moreno» → NM; «a@kb.test» → A; vacío → ?. */
export function initials(name: string | null): string {
  const parts = (name ?? '').replace(/@.*/, '').trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]![0]!;
  const last = parts.length > 1 ? parts[parts.length - 1]![0]! : '';
  return (first + last).toUpperCase();
}
/** Matiz estable (0–359) para colorear el avatar según el nombre. */
export function avatarHue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
