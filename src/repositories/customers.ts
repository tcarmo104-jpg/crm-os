import type { ServerSupabase } from '@/lib/supabase/server';
import { DbError, unwrap } from '@/lib/errors';
import { decodeCursor, encodeCursor } from '@/lib/cursor';
import { nameKey } from '@/lib/identity';
import type { CustomerRow, IdentifierRow, Page, TimelineEvent } from '@/lib/types';

const COLUMNS =
  'id, org_id, type, full_name, company_id, owner_id, team_id, city, country, address, preferred_channel, lifecycle_stage, do_not_contact, dnc_reason, dnc_at, custom_fields, first_contact_at, created_at';

interface Raw {
  id: string; org_id: string; type: 'person' | 'company'; full_name: string; company_id: string | null;
  owner_id: string | null; team_id: string | null; city: string | null; country: string | null; address: string | null;
  preferred_channel: CustomerRow['preferredChannel']; lifecycle_stage: string; do_not_contact: boolean;
  dnc_reason: string | null; dnc_at: string | null; custom_fields: Record<string, unknown>;
  first_contact_at: string; created_at: string;
}

const map = (r: Raw): CustomerRow => ({
  id: r.id, orgId: r.org_id, type: r.type, fullName: r.full_name, companyId: r.company_id, ownerId: r.owner_id,
  teamId: r.team_id, city: r.city, country: r.country, address: r.address, preferredChannel: r.preferred_channel,
  lifecycleStage: r.lifecycle_stage, doNotContact: r.do_not_contact, dncReason: r.dnc_reason, dncAt: r.dnc_at,
  customFields: r.custom_fields ?? {}, firstContactAt: r.first_contact_at, createdAt: r.created_at,
});

export interface ListParams {
  orgId: string;
  q?: string;
  owner?: 'all' | 'mine' | 'none';
  userId: string;
  cursor?: string;
  limit?: number;
  tagId?: string;
  city?: string;
  type?: 'person' | 'company';
  doNotContact?: boolean;
}

/** Lista con búsqueda (nombre, teléfono, correo), filtros y paginación por cursor. Solo devuelve lo que RLS permite. */
export async function listCustomers(db: ServerSupabase, p: ListParams): Promise<Page<CustomerRow>> {
  const limit = Math.min(p.limit ?? 25, 100);
  const q = (p.q ?? '').trim().slice(0, 80);

  let orFilter: string | null = null;
  if (q) {
    const conds: string[] = [];
    const key = nameKey(q);
    if (key) conds.push(`name_key.ilike.*${key}*`);

    // Búsqueda por identificador: parámetros saneados (solo caracteres seguros) antes de armar el filtro.
    const idConds: string[] = [];
    const safe = q.toLowerCase().replace(/[^a-z0-9@._-]/g, '');
    if (safe.length >= 3) idConds.push(`value.ilike.*${safe}*`);
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 4) idConds.push(`value.like.*${digits}*`);
    if (idConds.length > 0) {
      const ids = unwrap(
        await db.from('customer_identifiers').select('customer_id').eq('org_id', p.orgId).or(idConds.join(',')).limit(200),
      ) as { customer_id: string }[];
      const unique = [...new Set(ids.map((i) => i.customer_id))];
      if (unique.length > 0) conds.push(`id.in.(${unique.join(',')})`);
    }
    if (conds.length === 0) return { items: [], nextCursor: null };
    orFilter = conds.join(',');
  }

  let query = db.from('customers').select(COLUMNS).eq('org_id', p.orgId);
  if (orFilter) query = query.or(orFilter);
  if (p.owner === 'mine') query = query.eq('owner_id', p.userId);
  if (p.owner === 'none') query = query.is('owner_id', null);
  if (p.city) query = query.ilike('city', p.city);
  if (p.type) query = query.eq('type', p.type);
  if (p.doNotContact !== undefined) query = query.eq('do_not_contact', p.doNotContact);
  if (p.tagId) {
    const tagged = unwrap(
      await db.from('customer_tags').select('customer_id').eq('org_id', p.orgId).eq('tag_id', p.tagId).limit(500),
    ) as { customer_id: string }[];
    const ids = [...new Set(tagged.map((t) => t.customer_id))];
    if (ids.length === 0) return { items: [], nextCursor: null };
    query = query.in('id', ids);
  }

  const cur = decodeCursor(p.cursor);
  if (cur) query = query.or(`created_at.lt.${cur.ts},and(created_at.eq.${cur.ts},id.lt.${cur.id})`);

  const rows = unwrap(
    await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1),
  ) as unknown as Raw[];

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(map),
    nextCursor: rows.length > limit && last ? encodeCursor({ ts: last.created_at, id: last.id }) : null,
  };
}

/** Ciudades ya usadas en la organización (para el filtro «Ciudad»), sin traer todos los clientes. */
export async function listCitiesUsed(db: ServerSupabase, orgId: string): Promise<string[]> {
  const rows = unwrap(await db.from('customers').select('city').eq('org_id', orgId).not('city', 'is', null).limit(2000)) as unknown as { city: string }[];
  return [...new Set(rows.map((r) => r.city).filter(Boolean))].sort();
}

export async function getCustomer(db: ServerSupabase, id: string): Promise<CustomerRow | null> {
  const row = unwrap(await db.from('customers').select(COLUMNS).eq('id', id).maybeSingle()) as unknown as Raw | null;
  return row ? map(row) : null;
}

export async function getCustomersByIds(db: ServerSupabase, ids: string[]): Promise<CustomerRow[]> {
  if (ids.length === 0) return [];
  return (unwrap(await db.from('customers').select(COLUMNS).in('id', ids)) as unknown as Raw[]).map(map);
}

export async function listCompanies(db: ServerSupabase, orgId: string): Promise<{ id: string; fullName: string }[]> {
  const rows = unwrap(
    await db.from('customers').select('id, full_name').eq('org_id', orgId).eq('type', 'company').order('full_name').limit(200),
  ) as { id: string; full_name: string }[];
  return rows.map((r) => ({ id: r.id, fullName: r.full_name }));
}

export async function listIdentifiers(db: ServerSupabase, customerIds: string[]): Promise<IdentifierRow[]> {
  if (customerIds.length === 0) return [];
  const rows = unwrap(
    await db.from('customer_identifiers').select('id, customer_id, type, value, source').in('customer_id', customerIds).order('created_at'),
  ) as { id: string; customer_id: string; type: string; value: string; source: string | null }[];
  return rows.map((r) => ({ id: r.id, customerId: r.customer_id, type: r.type, value: r.value, source: r.source }));
}

export async function countCustomers(db: ServerSupabase, orgId: string): Promise<number> {
  const res = await db.from('customers').select('id', { count: 'exact', head: true }).eq('org_id', orgId);
  if (res.error) throw new DbError(res.error);
  return res.count ?? 0;
}

export async function timeline(db: ServerSupabase, customerId: string, limit = 50): Promise<TimelineEvent[]> {
  const rows = unwrap(await db.rpc('customer_timeline', { p_customer: customerId, p_limit: limit })) as
    | { id: string; type: string; occurred_at: string; actor_id: string | null; payload: Record<string, unknown> }[]
    | null;
  return (rows ?? []).map((r) => ({ id: r.id, type: r.type, occurredAt: r.occurred_at, actorId: r.actor_id, payload: r.payload ?? {} }));
}

export type CreateOutcome = { outcome: 'created' | 'existing'; customerId: string } | { outcome: 'duplicate_hidden' };

export async function createCustomer(
  db: ServerSupabase, orgId: string, type: string, fullName: string,
  identifiers: { type: string; value: string }[], attrs: Record<string, unknown>,
): Promise<CreateOutcome> {
  const r = unwrap(
    await db.rpc('create_customer', { p_org: orgId, p_type: type, p_full_name: fullName, p_ids: identifiers, p_attrs: attrs }),
  ) as { outcome: 'created' | 'existing' | 'duplicate_hidden'; customer_id?: string };
  return r.outcome === 'duplicate_hidden' || !r.customer_id
    ? { outcome: 'duplicate_hidden' }
    : { outcome: r.outcome, customerId: r.customer_id };
}

export async function updateCustomer(db: ServerSupabase, id: string, fields: Record<string, unknown>) {
  unwrap(await db.from('customers').update(fields).eq('id', id).select('id').single());
}

export async function addIdentifier(db: ServerSupabase, customerId: string, type: string, value: string) {
  return (unwrap(await db.rpc('add_customer_identifier', { p_customer: customerId, p_type: type, p_value: value })) as {
    outcome: 'added' | 'exists' | 'conflict';
  }).outcome;
}

export async function removeIdentifier(db: ServerSupabase, id: string) {
  unwrap(await db.from('customer_identifiers').delete().eq('id', id).select('id').single());
}
