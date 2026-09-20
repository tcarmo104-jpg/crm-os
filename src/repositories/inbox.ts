import type { ServerSupabase } from '@/lib/supabase/server';
import { sealSecret } from '@/lib/secrets';
import { unwrap } from '@/lib/errors';
import { decodeCursor, encodeCursor } from '@/lib/cursor';
import type { AttachmentRow, ChannelRow, ConnectionEventRow, ConversationRow, MessageRow, Page, QuickReplyRow, TagColor, TagRow, TemplateRow } from '@/lib/types';
import { dateFrom, safeSearchText, type InboxQuery } from '@/lib/inbox-view';

const CONV = 'id, channel_id, customer_id, thread_key, contact_name, status, owner_id, last_message_at, last_inbound_at, last_message_preview, last_direction, needs_reply, unread, unread_count';
interface RawConv {
  id: string; channel_id: string; customer_id: string; thread_key: string; contact_name: string | null; status: 'open' | 'closed'; owner_id: string | null;
  last_message_at: string | null; last_inbound_at: string | null; last_message_preview: string | null; last_direction: 'inbound' | 'outbound' | null;
  needs_reply: boolean; unread: boolean; unread_count: number;
}
const mapConv = (r: RawConv): ConversationRow => ({
  id: r.id, channelId: r.channel_id, customerId: r.customer_id, threadKey: r.thread_key, contactName: r.contact_name, status: r.status, ownerId: r.owner_id,
  lastMessageAt: r.last_message_at, lastInboundAt: r.last_inbound_at, lastMessagePreview: r.last_message_preview, lastDirection: r.last_direction,
  needsReply: r.needs_reply, unread: r.unread, unreadCount: r.unread_count ?? 0,
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
  const rows = unwrap(await db.from('messages').select('id, direction, kind, body, status, error, error_code, sent_by, occurred_at, meta')
    .eq('conversation_id', conversationId).order('occurred_at', { ascending: false }).order('created_at', { ascending: false }).limit(limit)) as unknown as
    { id: string; direction: 'inbound' | 'outbound'; kind: MessageRow['kind']; body: string; status: MessageRow['status']; error: string | null; error_code: string | null; sent_by: string | null; occurred_at: string; meta: Record<string, unknown> | null }[];
  return rows.reverse().map((r) => ({ id: r.id, direction: r.direction, kind: r.kind, body: r.body, status: r.status, error: r.error, errorCode: r.error_code, sentBy: r.sent_by, occurredAt: r.occurred_at, meta: r.meta ?? {} }));
}

/** Adjuntos de una conversación. La ruta del archivo NO se pide: el navegador solo conoce el id y pasa por la ruta autorizada. */
export async function listAttachments(db: ServerSupabase, conversationId: string): Promise<AttachmentRow[]> {
  const rows = unwrap(await db.from('message_attachments').select('id, message_id, kind, status, mime_type, file_name, file_size, width, height, is_voice, error_code, meta, position')
    .eq('conversation_id', conversationId).order('created_at').order('position').limit(1000)) as unknown as
    { id: string; message_id: string; kind: AttachmentRow['kind']; status: AttachmentRow['status']; mime_type: string | null; file_name: string | null; file_size: number | null;
      width: number | null; height: number | null; is_voice: boolean; error_code: string | null; meta: Record<string, unknown> | null }[];
  return rows.map((r) => ({ id: r.id, messageId: r.message_id, kind: r.kind, status: r.status, mimeType: r.mime_type, fileName: r.file_name, fileSize: r.file_size,
    width: r.width, height: r.height, isVoice: r.is_voice, errorCode: r.error_code, meta: r.meta ?? {} }));
}

export async function getMessageOutcome(db: ServerSupabase, id: string): Promise<{ status: string; error: string | null } | null> {
  const r = unwrap(await db.from('messages').select('status, error').eq('id', id).maybeSingle()) as unknown as { status: string; error: string | null } | null;
  return r;
}

const CHANNEL_COLUMNS = 'id, kind, name, external_id, display_phone, status, business_account_id, account_name, connection_status, connected_at, disconnected_at, last_sync_at, last_webhook_at, last_checked_at, last_error_code, metadata';
export async function listChannels(db: ServerSupabase, orgId: string): Promise<ChannelRow[]> {
  const rows = unwrap(await db.from('channels').select(CHANNEL_COLUMNS).eq('org_id', orgId).order('created_at')) as unknown as
    { id: string; kind: 'whatsapp' | 'facebook' | 'instagram' | 'gmail'; name: string; external_id: string; display_phone: string | null; status: 'active' | 'paused'; business_account_id: string | null; account_name: string | null;
      connection_status: string; connected_at: string | null; disconnected_at: string | null; last_sync_at: string | null; last_webhook_at: string | null; last_checked_at: string | null;
      last_error_code: string | null; metadata: Record<string, unknown> | null }[];
  return rows.map((r) => ({
    id: r.id, kind: r.kind, name: r.name, externalId: r.external_id, displayPhone: r.display_phone, status: r.status, businessAccountId: r.business_account_id, accountName: r.account_name,
    connectionStatus: r.connection_status, connectedAt: r.connected_at, disconnectedAt: r.disconnected_at, lastSyncAt: r.last_sync_at, lastWebhookAt: r.last_webhook_at,
    lastCheckedAt: r.last_checked_at, lastErrorCode: r.last_error_code, metadata: r.metadata ?? {},
  }));
}

/** Registro técnico de una conexión (solo lo ve un administrador; la base de datos lo garantiza). */
export async function listConnectionEvents(db: ServerSupabase, channelId: string, limit = 20): Promise<ConnectionEventRow[]> {
  const rows = unwrap(await db.from('connection_events').select('id, channel_id, kind, ok, code, detail, created_at').eq('channel_id', channelId).order('id', { ascending: false }).limit(limit)) as unknown as
    { id: number; channel_id: string; kind: string; ok: boolean; code: string | null; detail: string | null; created_at: string }[];
  return rows.map((r) => ({ id: r.id, channelId: r.channel_id, kind: r.kind, ok: r.ok, code: r.code, detail: r.detail, createdAt: r.created_at }));
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
  return unwrap(await db.rpc('create_channel', { p_org: orgId, p_name: a.name, p_external_id: a.phoneNumberId, p_display_phone: a.displayPhone ?? null, p_access_token: a.token ? sealSecret(a.token) : null })) as string;
}
export async function saveChannelToken(db: ServerSupabase, channelId: string, token: string) { unwrap(await db.rpc('save_channel_token', { p_channel: channelId, p_token: sealSecret(token) })); }
export async function connectChannel(db: ServerSupabase, orgId: string, a: { kind: 'facebook' | 'instagram' | 'gmail'; name: string; externalId: string; token: string; displayPhone?: string; accountName?: string; metadata?: Record<string, unknown> }): Promise<string> {
  return unwrap(await db.rpc('connect_channel', {
    p_org: orgId, p_kind: a.kind, p_name: a.name, p_external_id: a.externalId, p_display_phone: a.displayPhone ?? null, p_account_name: a.accountName ?? a.name,
    p_token: sealSecret(a.token), p_metadata: a.metadata ?? {},
  })) as string;
}
export async function setBusinessAccount(db: ServerSupabase, channelId: string, waba: string) { unwrap(await db.rpc('set_channel_business_account', { p_channel: channelId, p_waba: waba })); }
export async function disconnectChannel(db: ServerSupabase, channelId: string) { unwrap(await db.rpc('disconnect_channel', { p_channel: channelId })); }
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

// ---------------------------------------------------------------------------
// Bandeja de tres paneles: búsqueda y filtros
// ---------------------------------------------------------------------------
const EMPTY_PAGE: Page<ConversationRow> = { items: [], nextCursor: null };

/**
 * Lista de conversaciones con la pestaña + filtros avanzados + búsqueda del Inbox.
 * Todo pasa por RLS: cada persona solo obtiene lo que puede ver.
 */
export async function searchConversations(
  db: ServerSupabase, p: { orgId: string; userId: string; query: InboxQuery; cursor?: string; limit?: number },
): Promise<Page<ConversationRow>> {
  const { query: f } = p;
  const limit = Math.min(p.limit ?? 40, 100);
  let q = db.from('conversations').select(CONV).eq('org_id', p.orgId);

  switch (f.tab) {
    case 'unread': q = q.eq('unread', true); break;
    case 'pending': q = q.eq('needs_reply', true).eq('status', 'open'); break;
    case 'mine': q = q.eq('owner_id', p.userId); break;
    case 'unassigned': q = q.is('owner_id', null).eq('status', 'open'); break;
    case 'closed': q = q.eq('status', 'closed'); break;
    default: break;
  }
  if (f.estado) q = q.eq('status', f.estado);
  if (f.asesor === 'none') q = q.is('owner_id', null);
  else if (f.asesor) q = q.eq('owner_id', f.asesor);
  const from = dateFrom(f.fecha);
  if (from) q = q.gte('last_message_at', from);

  if (f.canal) {
    const ids = (await listChannels(db, p.orgId)).filter((c) => c.kind === f.canal).map((c) => c.id);
    if (ids.length === 0) return EMPTY_PAGE;               // canal aún sin conectar: no hay nada que mostrar
    q = q.in('channel_id', ids);
  }
  if (f.etiqueta) {
    const rows = unwrap(await db.from('customer_tags').select('customer_id').eq('tag_id', f.etiqueta).limit(2000)) as unknown as { customer_id: string }[];
    if (rows.length === 0) return EMPTY_PAGE;
    q = q.in('customer_id', rows.map((r) => r.customer_id));
  }
  const text = safeSearchText(f.q);
  if (text) {
    const like = `*${text}*`;
    const byName = unwrap(await db.from('customers').select('id').eq('org_id', p.orgId).ilike('full_name', like).limit(200)) as unknown as { id: string }[];
    const parts = [`contact_name.ilike.${like}`, `last_message_preview.ilike.${like}`, `thread_key.ilike.${like}`];
    if (byName.length > 0) parts.push(`customer_id.in.(${byName.map((r) => r.id).join(',')})`);
    q = q.or(parts.join(','));
  }

  const cur = decodeCursor(p.cursor);
  if (cur) q = q.or(`last_message_at.lt.${cur.ts},and(last_message_at.eq.${cur.ts},id.lt.${cur.id})`);
  const rows = unwrap(await q.order('last_message_at', { ascending: false, nullsFirst: false }).order('id', { ascending: false }).limit(limit + 1)) as unknown as RawConv[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(mapConv), nextCursor: rows.length > limit && last?.last_message_at ? encodeCursor({ ts: last.last_message_at, id: last.id }) : null };
}

/** Números de las pestañas «No leídas», «Pendientes» y «Sin asignar» (solo recuento, sin traer filas). */
export async function tabCounts(db: ServerSupabase, orgId: string): Promise<{ unread: number; pending: number; unassigned: number }> {
  const head = () => db.from('conversations').select('id', { count: 'exact', head: true }).eq('org_id', orgId);
  const [unread, pending, unassigned] = await Promise.all([
    head().eq('unread', true),
    head().eq('needs_reply', true).eq('status', 'open'),
    head().is('owner_id', null).eq('status', 'open'),
  ]);
  for (const r of [unread, pending, unassigned]) if (r.error) throw new Error(r.error.message);
  return { unread: unread.count ?? 0, pending: pending.count ?? 0, unassigned: unassigned.count ?? 0 };
}

// ---------------------------------------------------------------------------
// Etiquetas y respuestas rápidas
// ---------------------------------------------------------------------------
export async function listTags(db: ServerSupabase, orgId: string): Promise<TagRow[]> {
  const rows = unwrap(await db.from('tags').select('id, name, color').eq('org_id', orgId).order('name')) as unknown as { id: string; name: string; color: TagColor }[];
  return rows.map((r) => ({ id: r.id, name: r.name, color: r.color }));
}

export async function tagsByCustomer(db: ServerSupabase, customerIds: string[]): Promise<Map<string, TagRow[]>> {
  const out = new Map<string, TagRow[]>();
  if (customerIds.length === 0) return out;
  const rows = unwrap(await db.from('customer_tags').select('customer_id, tag:tags(id, name, color)').in('customer_id', customerIds)) as unknown as
    { customer_id: string; tag: { id: string; name: string; color: TagColor } | null }[];
  for (const r of rows) {
    if (!r.tag) continue;
    const list = out.get(r.customer_id) ?? [];
    list.push({ id: r.tag.id, name: r.tag.name, color: r.tag.color });
    out.set(r.customer_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return out;
}

export async function addCustomerTag(db: ServerSupabase, customerId: string, name: string, color?: TagColor): Promise<string> {
  return unwrap(await db.rpc('add_customer_tag', { p_customer: customerId, p_name: name, p_color: color ?? null })) as string;
}
export async function removeCustomerTag(db: ServerSupabase, customerId: string, tagId: string) {
  unwrap(await db.rpc('remove_customer_tag', { p_customer: customerId, p_tag: tagId }));
}

export async function listQuickReplies(db: ServerSupabase, orgId: string): Promise<QuickReplyRow[]> {
  const rows = unwrap(await db.from('quick_replies').select('id, title, body').eq('org_id', orgId).order('title')) as unknown as QuickReplyRow[];
  return rows.map((r) => ({ id: r.id, title: r.title, body: r.body }));
}
export async function createQuickReply(db: ServerSupabase, orgId: string, title: string, body: string): Promise<string> {
  return unwrap(await db.rpc('create_quick_reply', { p_org: orgId, p_title: title, p_body: body })) as string;
}
export async function deleteQuickReply(db: ServerSupabase, id: string) { unwrap(await db.rpc('delete_quick_reply', { p_id: id })); }
