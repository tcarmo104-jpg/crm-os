import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import { closeRange, createdFrom, type BoardCard, type KanbanQuery, type OppChannel } from '@/lib/kanban';
import { safeSearchText } from '@/lib/inbox-view';
import type {
  ActivityRow, CustomerRow, IdentifierRow, LineItem, MemberRow, OpportunityRow, PipelineRow, QuoteRow, TaskRow, TransitionRow,
} from '@/lib/types';
import { getCustomer, getCustomersByIds, listIdentifiers } from './customers';
import { listActivities } from './activities';
import { getOpportunity, listTransitions } from './opportunities';
import { listQuotes, listItems } from './quotes';
import { listTasks } from './tasks';

export const OPEN_LIMIT = 500;
export const CLOSED_LIMIT = 200;
export const CLOSED_WINDOW_DAYS = 30;

const COLUMNS = 'id, number, customer_id, stage_id, title, amount, currency, expected_close_date, product_interest, status, lost_reason, closed_at, owner_id, priority, temperature, channel, conversation_id, created_at';
interface Raw {
  id: string; number: string; customer_id: string; stage_id: string; title: string; amount: number | string; currency: string | null; expected_close_date: string | null;
  product_interest: string | null; status: BoardCard['status']; lost_reason: string | null; closed_at: string | null; owner_id: string | null; priority: BoardCard['priority'];
  temperature: BoardCard['temperature']; channel: string | null; conversation_id: string | null; created_at: string;
}
const ids = (rows: { id?: string; customer_id?: string; opportunity_id?: string }[], k: 'id' | 'customer_id' | 'opportunity_id') => [...new Set(rows.map((r) => r[k]).filter((x): x is string => !!x))];

export interface BoardResult { cards: BoardCard[]; openTruncated: boolean; closedTruncated: boolean }

/**
 * Tarjetas del tablero con los filtros y la búsqueda de la URL. Todo pasa por RLS: cada persona ve solo lo suyo.
 * Abiertas: hasta 500. Ganadas/Perdidas: solo las de los últimos 30 días (salvo que se filtre por esa etapa).
 */
export async function loadBoard(
  db: ServerSupabase, p: { orgId: string; pipeline: PipelineRow; query: KanbanQuery; members: MemberRow[]; now?: Date },
): Promise<BoardResult> {
  const f = p.query;
  const now = p.now ?? new Date();
  const empty: BoardResult = { cards: [], openTruncated: false, closedTruncated: false };

  // --- filtros que pasan por otras tablas -----------------------------------------------------------------------
  let regionIds: string[] | null = null;
  if (f.region) {
    const text = safeSearchText(f.region);
    const rows = text ? unwrap(await db.from('customers').select('id').eq('org_id', p.orgId).ilike('city', `*${text}*`).limit(2000)) as unknown as { id: string }[] : [];
    regionIds = rows.map((r) => r.id);
    if (regionIds.length === 0) return empty;
  }
  let productOppIds: string[] | null = null;
  let productName = '';
  if (f.producto) {
    const prod = unwrap(await db.from('products').select('name').eq('id', f.producto).maybeSingle()) as unknown as { name: string } | null;
    productName = safeSearchText(prod?.name ?? '');
    const items = unwrap(await db.from('quote_items').select('quote_id').eq('product_id', f.producto).limit(2000)) as unknown as { quote_id: string }[];
    const quotes = items.length ? unwrap(await db.from('quotes').select('opportunity_id').in('id', [...new Set(items.map((i) => i.quote_id))])) as unknown as { opportunity_id: string }[] : [];
    productOppIds = [...new Set(quotes.map((q) => q.opportunity_id))];
  }

  // --- búsqueda: cliente, oportunidad, teléfono, correo, producto, número ---------------------------------------
  const text = safeSearchText(f.q);
  let orClause = '';
  if (text) {
    const like = `*${text}*`;
    // Los dígitos sueltos solo se buscan en teléfonos si lo escrito PARECE un teléfono (sin letras): «OPP-0003» no debe coincidir con 3001110003.
    const digits = /^[\d\s+.-]+$/.test(text) ? text.replace(/\D/g, '') : '';
    const [byName, byIdent, byItem] = await Promise.all([
      db.from('customers').select('id').eq('org_id', p.orgId).ilike('full_name', like).limit(300),
      db.from('customer_identifiers').select('customer_id').eq('org_id', p.orgId).or(`value.ilike.${like}${digits.length >= 3 ? `,value.ilike.*${digits}*` : ''}`).limit(300),
      db.from('quote_items').select('quote_id').ilike('description', like).limit(300),
    ]);
    const custIds = [...new Set([...ids(unwrap(byName) as never, 'id'), ...ids(unwrap(byIdent) as never, 'customer_id')])];
    const itemQuotes = ids((unwrap(byItem) as unknown as { quote_id: string }[]).map((r) => ({ id: r.quote_id })), 'id');
    const oppIds = itemQuotes.length ? ids(unwrap(await db.from('quotes').select('opportunity_id').in('id', itemQuotes)) as never, 'opportunity_id') : [];
    const parts = [`title.ilike.${like}`, `number.ilike.${like}`, `product_interest.ilike.${like}`];
    if (custIds.length) parts.push(`customer_id.in.(${custIds.join(',')})`);
    if (oppIds.length) parts.push(`id.in.(${oppIds.join(',')})`);
    orClause = parts.join(',');
  }

  const stageKind = f.etapa ? p.pipeline.stages.find((s) => s.id === f.etapa)?.kind : undefined;
  const build = () => {
    let q = db.from('opportunities').select(COLUMNS).eq('org_id', p.orgId).eq('pipeline_id', p.pipeline.id);
    if (f.asesor === 'none') q = q.is('owner_id', null); else if (f.asesor) q = q.eq('owner_id', f.asesor);
    if (f.equipo) q = q.eq('team_id', f.equipo);
    if (f.canal) q = q.eq('channel', f.canal);
    if (f.prioridad) q = q.eq('priority', f.prioridad);
    if (f.temperatura) q = q.eq('temperature', f.temperatura);
    if (f.etapa) q = q.eq('stage_id', f.etapa);
    const from = createdFrom(f.creada, now);
    if (from) q = q.gte('created_at', from);
    const cr = closeRange(f.cierre, now);
    if (cr?.none) q = q.is('expected_close_date', null);
    else if (cr) { if (cr.from) q = q.gte('expected_close_date', cr.from); if (cr.to) q = q.lte('expected_close_date', cr.to); }
    if (f.min) q = q.gte('amount', Number(f.min));
    if (f.max) q = q.lte('amount', Number(f.max));
    if (regionIds) q = q.in('customer_id', regionIds);
    if (productOppIds) {
      const parts = [productOppIds.length ? `id.in.(${productOppIds.join(',')})` : '', productName ? `product_interest.ilike.*${productName}*` : ''].filter(Boolean);
      if (parts.length === 0) return null;
      q = q.or(parts.join(','));
    }
    if (orClause) q = q.or(orClause);
    return q;
  };

  const wantOpen = stageKind === undefined || stageKind === 'open';
  const wantClosed = stageKind === undefined || stageKind !== 'open';
  const [openQ, closedQ] = [wantOpen ? build() : null, wantClosed ? build() : null];
  const [openRows, closedRows] = await Promise.all([
    openQ ? openQ.eq('status', 'open').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(OPEN_LIMIT + 1) : Promise.resolve(null),
    closedQ
      ? (stageKind ? closedQ : closedQ.gte('closed_at', new Date(now.getTime() - CLOSED_WINDOW_DAYS * 86400000).toISOString()))
          .in('status', ['won', 'lost']).order('closed_at', { ascending: false }).order('id', { ascending: false }).limit(CLOSED_LIMIT + 1)
      : Promise.resolve(null),
  ]);
  const open = openRows ? (unwrap(openRows) as unknown as Raw[]) : [];
  const closed = closedRows ? (unwrap(closedRows) as unknown as Raw[]) : [];
  const rows = [...open.slice(0, OPEN_LIMIT), ...closed.slice(0, CLOSED_LIMIT)];

  // --- datos de apoyo: cliente, asesor, producto ----------------------------------------------------------------
  const customers = await getCustomersByIds(db, [...new Set(rows.map((r) => r.customer_id))]);
  const cName = new Map(customers.map((c) => [c.id, c.fullName]));
  const owner = new Map(p.members.map((m) => [m.userId, m.fullName ?? m.email ?? 'Sin nombre']));
  const firstItem = new Map<string, string>();
  const needProduct = rows.filter((r) => !r.product_interest).map((r) => r.id);
  if (needProduct.length) {
    const qs = unwrap(await db.from('quotes').select('id, opportunity_id, status, created_at').in('opportunity_id', needProduct).neq('status', 'superseded').order('created_at', { ascending: false })) as unknown as
      { id: string; opportunity_id: string; status: string }[];
    const latest = new Map<string, string>();
    for (const q of qs) if (!latest.has(q.opportunity_id)) latest.set(q.opportunity_id, q.id);
    if (latest.size) {
      const items = unwrap(await db.from('quote_items').select('quote_id, description, position').in('quote_id', [...latest.values()]).order('position')) as unknown as { quote_id: string; description: string }[];
      const byQuote = new Map<string, string>();
      for (const it of items) if (!byQuote.has(it.quote_id)) byQuote.set(it.quote_id, it.description);
      for (const [opp, quote] of latest) if (byQuote.has(quote)) firstItem.set(opp, byQuote.get(quote)!);
    }
  }

  const cards: BoardCard[] = rows.map((r) => ({
    id: r.id, number: r.number, title: r.title, amount: Number(r.amount), currency: r.currency, stageId: r.stage_id, status: r.status,
    priority: r.priority, temperature: r.temperature, channel: (r.channel as OppChannel | null), customerId: r.customer_id,
    customerName: cName.get(r.customer_id) ?? 'Cliente no disponible', ownerId: r.owner_id, ownerName: r.owner_id ? (owner.get(r.owner_id) ?? '—') : null,
    createdAt: r.created_at, expectedCloseDate: r.expected_close_date, product: r.product_interest ?? firstItem.get(r.id) ?? null,
    conversationId: r.conversation_id, lostReason: r.lost_reason,
  }));
  return { cards, openTruncated: open.length > OPEN_LIMIT, closedTruncated: closed.length > CLOSED_LIMIT };
}

// ---------------------------------------------------------------------------------------------------------------
// Detalle (panel lateral)
// ---------------------------------------------------------------------------------------------------------------
export interface ProductLineDetail { description: string; quantity: number; total: number }
export interface OpportunityDetail {
  opp: OpportunityRow; customer: CustomerRow; identifiers: IdentifierRow[]; company: { id: string; fullName: string } | null;
  quotes: QuoteRow[]; products: ProductLineDetail[]; productsFrom: string | null; activities: ActivityRow[]; tasks: TaskRow[]; transitions: TransitionRow[];
}

export async function loadOpportunityDetail(db: ServerSupabase, orgId: string, id: string): Promise<OpportunityDetail | null> {
  const opp = await getOpportunity(db, id);
  if (!opp) return null;
  const customer = await getCustomer(db, opp.customerId);
  if (!customer) return null;
  const [identifiers, quotesPage, activities, tasks, transitions, companies] = await Promise.all([
    listIdentifiers(db, [customer.id]),
    listQuotes(db, { orgId, opportunityId: id, limit: 50 }),
    listActivities(db, { opportunityId: id, limit: 50 }),
    listTasks(db, { orgId, opportunityId: id, limit: 50 }),
    listTransitions(db, 'opportunity', id),
    customer.companyId ? getCustomersByIds(db, [customer.companyId]) : Promise.resolve([] as CustomerRow[]),
  ]);
  const active = quotesPage.items.find((q) => q.status !== 'superseded' && q.status !== 'rejected') ?? null;   // la más reciente vigente
  let products: ProductLineDetail[] = [];
  if (active) {
    const items: LineItem[] = await listItems(db, active.id);
    products = items.map((i) => ({ description: i.description, quantity: i.quantity, total: i.lineTotal }));
  }
  return {
    opp, customer, identifiers, company: companies[0] ? { id: companies[0].id, fullName: companies[0].fullName } : null,
    quotes: quotesPage.items, products, productsFrom: active ? active.number : null, activities, tasks, transitions,
  };
}

export async function setOpportunityFields(db: ServerSupabase, id: string, fields: { priority?: string; temperature?: string | null; channel?: string | null }) {
  const patch: Record<string, unknown> = {};
  if (fields.priority !== undefined) patch.priority = fields.priority;
  if (fields.temperature !== undefined) patch.temperature = fields.temperature;
  if (fields.channel !== undefined) patch.channel = fields.channel;
  unwrap(await db.from('opportunities').update(patch).eq('id', id).select('id').single());
}
export async function linkConversation(db: ServerSupabase, id: string, conversationId: string | null) {
  unwrap(await db.rpc('link_opportunity_conversation', { p_opportunity: id, p_conversation: conversationId }));
}

/** Ciudades de los clientes (para sugerir en el filtro «Región»). */
export async function listCities(db: ServerSupabase, orgId: string): Promise<string[]> {
  const rows = unwrap(await db.from('customers').select('city').eq('org_id', orgId).not('city', 'is', null).limit(1000)) as unknown as { city: string }[];
  const count = new Map<string, number>();
  for (const r of rows) { const c = r.city.trim(); if (c) count.set(c, (count.get(c) ?? 0) + 1); }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es')).slice(0, 40).map(([c]) => c);
}
