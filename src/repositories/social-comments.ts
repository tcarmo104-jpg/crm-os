import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { CommentStatus } from '@/lib/comments';

export interface SocialPostRow { id: string; channelId: string; externalId: string; permalink: string | null; caption: string | null; postedAt: string | null }
export interface SocialCommentRow {
  id: string; channelId: string; postId: string | null; externalId: string; parentExternalId: string | null; customerId: string | null;
  authorName: string; authorExternalId: string; message: string | null; status: CommentStatus; occurredAt: string;
  repliedPubliclyAt: string | null; repliedPubliclyText: string | null; privateReplyAt: string | null;
}

const POST_COLUMNS = 'id, channel_id, external_id, permalink, caption, posted_at';
const mapPost = (r: Record<string, unknown>): SocialPostRow => ({
  id: r.id as string, channelId: r.channel_id as string, externalId: r.external_id as string,
  permalink: r.permalink as string | null, caption: r.caption as string | null, postedAt: r.posted_at as string | null,
});
const COMMENT_COLUMNS = 'id, channel_id, post_id, external_id, parent_external_id, customer_id, author_name, author_external_id, message, status, occurred_at, replied_publicly_at, replied_publicly_text, private_reply_at';
const mapComment = (r: Record<string, unknown>): SocialCommentRow => ({
  id: r.id as string, channelId: r.channel_id as string, postId: r.post_id as string | null, externalId: r.external_id as string,
  parentExternalId: r.parent_external_id as string | null, customerId: r.customer_id as string | null,
  authorName: r.author_name as string, authorExternalId: r.author_external_id as string, message: r.message as string | null,
  status: r.status as CommentStatus, occurredAt: r.occurred_at as string, repliedPubliclyAt: r.replied_publicly_at as string | null,
  repliedPubliclyText: r.replied_publicly_text as string | null, privateReplyAt: r.private_reply_at as string | null,
});

export async function listPosts(db: ServerSupabase, orgId: string, limit = 20): Promise<SocialPostRow[]> {
  const rows = unwrap(await db.from('social_posts').select(POST_COLUMNS).eq('org_id', orgId).order('created_at', { ascending: false }).limit(limit)) as unknown as Record<string, unknown>[];
  return rows.map(mapPost);
}
export async function listCommentsForPosts(db: ServerSupabase, orgId: string, postIds: string[]): Promise<SocialCommentRow[]> {
  if (postIds.length === 0) return [];
  const rows = unwrap(await db.from('social_comments').select(COMMENT_COLUMNS).eq('org_id', orgId).in('post_id', postIds).order('occurred_at', { ascending: true })) as unknown as Record<string, unknown>[];
  return rows.map(mapComment);
}
export async function getComment(db: ServerSupabase, id: string): Promise<SocialCommentRow | null> {
  const rows = unwrap(await db.from('social_comments').select(COMMENT_COLUMNS).eq('id', id).limit(1)) as unknown as Record<string, unknown>[];
  return rows[0] ? mapComment(rows[0]) : null;
}
export async function getPost(db: ServerSupabase, id: string): Promise<SocialPostRow | null> {
  const rows = unwrap(await db.from('social_posts').select(POST_COLUMNS).eq('id', id).limit(1)) as unknown as Record<string, unknown>[];
  return rows[0] ? mapPost(rows[0]) : null;
}
export async function upsertPostMeta(db: ServerSupabase, id: string, permalink: string | null, caption: string | null, postedAt: string | null): Promise<void> {
  unwrap(await db.from('social_posts').update({ permalink, caption, posted_at: postedAt }).eq('id', id));
}
export async function setCommentStatus(db: ServerSupabase, id: string, status: CommentStatus): Promise<void> { unwrap(await db.rpc('set_comment_status', { p_comment_id: id, p_status: status })); }
export async function recordCommentReply(db: ServerSupabase, id: string, kind: 'public' | 'private', text?: string): Promise<string | null> {
  return unwrap(await db.rpc('record_comment_reply', { p_comment_id: id, p_kind: kind, p_text: text ?? null })) as unknown as string | null;
}
export async function getChannelToken(db: ServerSupabase, channelId: string): Promise<string | null> {
  return unwrap(await db.rpc('channel_credentials', { p_channel: channelId })) as unknown as string | null;
}
