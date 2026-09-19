import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import { decodeCursor, encodeCursor } from '@/lib/cursor';
import type { ChannelRow, ConversationRow, MessageRow, Page, TemplateRow } from '@/lib/types';

const CONV = 'id, channel_id, customer_id, thread_key, contact_name, status, owner_id, last_message_at, last_inbound_at, last_message_preview, last_direction, needs_reply, unread';
interface RawConv {
  id: string; channel_id: string; customer_id: string; thread_key: string; contact_name: string | null; status: 'open' | 'closed'; owner_id: string | null;
  last_message_at: string | null; last_inbound_at: string | null; last_message_preview: string | null; last_direction: 'inbound' | 'outbound' | null;
  needs_reply: boolean; unread: boolean;
}
const mapConv = (r: RawConv): ConversationRow => ({
  id: r.id, channelId: r.channel_id, customerId: r.customer_id, threadKey: r.thread_key, contactName: r.contact_name, status: r.status, ownerId: r.owner_id,
  lastMessageAt: r.last_message_at, lastInboundAt: r.last_inbound_at, lastMessagePreview: r.last_message_preview, lastDirection: r.last_direction,
  needsReply: r.needs_reply, unread: r.unread,
});

export type InboxFilter = 'reply' | 'open' | 'unassigned' | 'closed';

export async function listConversations(
  db: ServerSupabase, p: { orgId: string; filter: InboxFilter; customerId?: string; cursor?: string; limit?: number },
): Promise<Page<ConversationRow>> {
  const limit = Math.min(p.limit ?? 30, 100);
  let q = db.from('conversations').select(CONV).eq('org_id', p.orgId);
  if (p.customerId) q = q.eq('customer_id', p.customerId);
  else if (p.filter === 'closed') q = q.eq('status', 'closed');
  else {
    q = q.eq('status', 'open');
    if (p.filter === 'reply') q = q.eq('needs_reply', true);
    if (p.filter === 'unassigned') q = q.is('owner_id', null);
  }
  const cur = decodeCursor(p.cursor);
  if (cur) q = q.or(`last_message_at.lt.${cur.ts},and(last_message_at.eq.${cur.ts},id.lt.${cur.id})`);
  const rows = unwrap(await q.order('last_message_at', { ascending: false, nullsFirst: false }).order('id', { ascending: false }).limit(limit + 1)) as unknown as RawConv[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(mapConv), nextCursor: rows.length > limit && last?.last_message_at ? encodeCursor({ ts: last.last_message_at, id: last.id }) : null };
}

export async function getConversation(db: ServerSupabase, id: string): Promise<ConversationRow | null> {
  const r = unwrap(await db.from('conversations').select(CONV).eq('id', id).maybeSingle()) as unknown as RawConv | null;
  return r ? mapConv(r) : null;
}

/** Los últimos `limit` mensajes, en orden cronológico. */
export async function listMessages(db: ServerSupabase, conversationId: string, limit = 300): Promise<MessageRow[]> {
  const rows = unwrap(await db.from('messages').select('id, direction, kind, body, status, error, error_code, sent_by, occurred_at')
    .eq('conversation_id', conversationId).order('occurred_at', { ascending: false }).order('created_at', { ascending: false }).limit(limit)) as unknown as
    { id: string; direction: 'inbound' | 'outbound'; kind: MessageRow['kind']; body: string; status: MessageRow['status']; error: string | null; error_code: string | null; sent_by: string | null; occurred_at: string }[];
  return rows.reverse().map((r) => ({ id: r.id, direction: r.direction, kind: r.kind, body: r.body, status: r.status, error: r.error, errorCode: r.error_code, sentBy: r.sent_by, occurredAt: r.occurred_at }));
}

export async function getMessageOutcome(db: ServerSupabase, id: string): Promise<{ status: string; error: string | null } | null> {
  const r = unwrap(await db.from('messages').select('status, error').eq('id', id).maybeSingle()) as unknown as { status: string; error: string | null } | null;
  return r;
}

export async function listChannels(db: ServerSupabase, orgId: string): Promise<ChannelRow[]> {
  const rows = unwrap(await db.from('channels').select('id, kind, name, external_id, display_phone, status').eq('org_id', orgId).order('created_at')) as unknown as
    { id: string; kind: 'whatsapp'; name: string; external_id: string; display_phone: string | null; status: 'active' | 'paused' }[];
  return rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, externalId: r.external_id, displayPhone: r.display_phone, status: r.status }));
}

export async function channelTokenStatus(db: ServerSupabase, orgId: string): Promise<Map<string, boolean>> {
  const rows = unwrap(await db.rpc('channel_token_status', { p_org: orgId })) as unknown as { channel_id: string; has_token: boolean }[];
  return new Map(rows.map((r) => [r.channel_id, r.has_token]));
}

export async function listTemplates(db: ServerSupabase, orgId: string): Promise<TemplateRow[]> {
  const rows = unwrap(await db.from('message_templates').select('id, channel_id, name, language, body, param_count, status').eq('org_id', orgId).order('name')) as unknown as
    { id: string; channel_id: string; name: string; language: string; body: string; param_count: number; status: 'approved' | 'disabled' }[];
  return rows.map((r) => ({ id: r.id, channelId: r.channel_id, name: r.name, language: r.language, body: r.body, paramCount: r.param_count, status: r.status }));
}

export async function createChannel(db: ServerSupabase, orgId: string, a: { name: string; phoneNumberId: string; displayPhone?: string; token?: string }): Promise<string> {
  return unwrap(await db.rpc('create_channel', { p_org: orgId, p_name: a.name, p_external_id: a.phoneNumberId, p_display_phone: a.displayPhone ?? null, p_access_token: a.token ?? null })) as string;
}
export async function saveChannelToken(db: ServerSupabase, channelId: string, token: string) { unwrap(await db.rpc('save_channel_token', { p_channel: channelId, p_token: token })); }
export async function setChannelStatus(db: ServerSupabase, channelId: string, status: 'active' | 'paused') { unwrap(await db.rpc('set_channel_status', { p_channel: channelId, p_status: status })); }
export async function createTemplate(db: ServerSupabase, orgId: string, a: { channelId: string; name: string; language: string; body: string }) {
  unwrap(await db.from('message_templates').insert({ org_id: orgId, channel_id: a.channelId, name: a.name, language: a.language, body: a.body }).select('id').single());
}
export async function setTemplateStatus(db: ServerSupabase, id: string, status: 'approved' | 'disabled') {
  unwrap(await db.from('message_templates').update({ status }).eq('id', id).select('id').single());
}
export async function queueMessage(db: ServerSupabase, conversationId: string, body: string): Promise<string> {
  return unwrap(await db.rpc('queue_message', { p_conversation: conversationId, p_body: body })) as string;
}
export async function queueTemplate(db: ServerSupabase, conversationId: string, templateId: string, params: string[]): Promise<string> {
  return unwrap(await db.rpc('queue_template_message', { p_conversation: conversationId, p_template: templateId, p_params: params })) as string;
}
export async function markRead(db: ServerSupabase, id: string) { unwrap(await db.rpc('mark_conversation_read', { p_id: id })); }
export async function setConversationStatus(db: ServerSupabase, id: string, status: 'open' | 'closed') { unwrap(await db.rpc('set_conversation_status', { p_id: id, p_status: status })); }
