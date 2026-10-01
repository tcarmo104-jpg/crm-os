import { z } from 'zod';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import { openSecret } from '@/lib/secrets';
import { canReplyPrivately } from '@/lib/comments';
import { createAdminClient } from '@/server/supabase-admin';
import * as repo from '@/repositories/social-comments';
import {
  deleteComment as deleteCommentOnMeta, fetchPostMeta, fetchRecentPosts, replyToCommentPublic, sendPrivateReplyToComment, setCommentHidden,
} from '@/server/meta-social';
import { firstIssue } from './schemas';

const replySchema = z.string().trim().min(1, 'Escribe un mensaje antes de enviarlo.').max(2000, 'El mensaje es demasiado largo.');

async function channelFor(db: ServerSupabase, channelId: string) {
  const { data, error } = await db.from('channels').select('id, kind, external_id').eq('id', channelId).single();
  if (error || !data) throw new UserFacingError('No encontramos el canal de este comentario.');
  return data as { id: string; kind: 'facebook' | 'instagram'; external_id: string };
}
// El token de un canal NUNCA se lee con la sesión de la persona (igual que en todo el resto del CRM):
// `channel_credentials` solo lo puede ejecutar el servidor, con su propio cliente de administrador.
async function tokenFor(channelId: string): Promise<string> {
  const stored = await repo.getChannelToken(createAdminClient(), channelId);
  if (!stored) throw new UserFacingError('Esta página no tiene una conexión activa con Meta. Conéctala de nuevo en Configuración → Conexiones.');
  try { return openSecret(stored); } catch { throw new UserFacingError('No pudimos leer la conexión con Meta. Vuelve a conectar la página.'); }
}

/** Trae publicaciones recientes de Meta y las guarda (o actualiza su permalink/texto si ya existían). */
export async function refreshRecentPosts(db: ServerSupabase, orgId: string, channelId: string): Promise<void> {
  const ch = await channelFor(db, channelId);
  const token = await tokenFor(channelId);
  const posts = await fetchRecentPosts(ch.kind, ch.external_id, token);
  if (!posts) throw new UserFacingError('No pudimos traer las publicaciones de Meta. Inténtalo de nuevo en un momento.');
  for (const p of posts) {
    const { error } = await db.from('social_posts').upsert(
      { org_id: orgId, channel_id: channelId, external_id: p.externalId, permalink: p.permalink, caption: p.caption, posted_at: p.createdAt },
      { onConflict: 'channel_id,external_id' },
    );
    if (error) throw new UserFacingError('No pudimos guardar las publicaciones. Inténtalo de nuevo.');
  }
}

/** Completa el permalink/texto de una publicación que solo teníamos con su id (la primera vez que llegó un comentario). */
export async function enrichPostIfNeeded(db: ServerSupabase, postId: string): Promise<void> {
  const post = await repo.getPost(db, postId);
  if (!post || post.permalink) return;
  const ch = await channelFor(db, post.channelId);
  const token = await tokenFor(post.channelId);
  const meta = await fetchPostMeta(ch.kind, post.externalId, token);
  if (meta) await repo.upsertPostMeta(db, postId, meta.permalink, meta.caption, meta.createdAt);
}

export async function replyPublic(db: ServerSupabase, commentId: string, text: unknown): Promise<void> {
  const r = replySchema.safeParse(text);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  const c = await repo.getComment(db, commentId);
  if (!c) throw new UserFacingError('No encontramos ese comentario.');
  const token = await tokenFor(c.channelId);
  const res = await replyToCommentPublic(c.externalId, r.data, token);
  if (!res.ok) throw new UserFacingError(res.message);
  await repo.recordCommentReply(db, commentId, 'public', r.data);
}

export async function replyPrivate(db: ServerSupabase, commentId: string, text: unknown): Promise<void> {
  const r = replySchema.safeParse(text);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  const c = await repo.getComment(db, commentId);
  if (!c) throw new UserFacingError('No encontramos ese comentario.');
  if (!canReplyPrivately(c.occurredAt)) throw new UserFacingError('Ya pasaron más de 7 días desde el comentario: Meta ya no permite responder en privado.');
  const token = await tokenFor(c.channelId);
  const res = await sendPrivateReplyToComment(c.externalId, r.data, token);
  if (!res.ok) throw new UserFacingError(res.message);
  await repo.recordCommentReply(db, commentId, 'private', r.data);
}

export async function hideComment(db: ServerSupabase, commentId: string, hidden: boolean): Promise<void> {
  const c = await repo.getComment(db, commentId);
  if (!c) throw new UserFacingError('No encontramos ese comentario.');
  const token = await tokenFor(c.channelId);
  const res = await setCommentHidden(c.externalId, hidden, token);
  if (!res.ok) throw new UserFacingError(res.message);
  await repo.setCommentStatus(db, commentId, hidden ? 'hidden' : 'visible');
}

export async function deleteComment(db: ServerSupabase, commentId: string): Promise<void> {
  const c = await repo.getComment(db, commentId);
  if (!c) throw new UserFacingError('No encontramos ese comentario.');
  const token = await tokenFor(c.channelId);
  const res = await deleteCommentOnMeta(c.externalId, token);
  if (!res.ok) throw new UserFacingError(res.message);
  await repo.setCommentStatus(db, commentId, 'deleted');
}
