'use server';

import { revalidatePath } from 'next/cache';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import * as service from '@/services/social-comments';

export async function refreshPostsAction(channelId: string): Promise<void> {
  const { org, db } = await actionContext();
  try {
    await service.refreshRecentPosts(db, org.orgId, channelId);
    await setFlash({ kind: 'ok', message: 'Publicaciones actualizadas.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/comments');
}

export async function replyPublicAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const commentId = str(fd.get('commentId'));
  try {
    await service.replyPublic(db, commentId, str(fd.get('message')));
    await setFlash({ kind: 'ok', message: 'Respondido en público.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/comments');
}

export async function replyPrivateAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const commentId = str(fd.get('commentId'));
  try {
    await service.replyPrivate(db, commentId, str(fd.get('message')));
    await setFlash({ kind: 'ok', message: 'Respuesta privada enviada. Ya puedes verla en el Inbox.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/comments');
}

export async function toggleHiddenAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const commentId = str(fd.get('commentId'));
  const hidden = str(fd.get('hidden')) === '1';
  try {
    await service.hideComment(db, commentId, hidden);
    await setFlash({ kind: 'ok', message: hidden ? 'Comentario ocultado.' : 'Comentario visible de nuevo.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/comments');
}

export async function deleteCommentAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const commentId = str(fd.get('commentId'));
  try {
    await service.deleteComment(db, commentId);
    await setFlash({ kind: 'ok', message: 'Comentario eliminado.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/comments');
}
