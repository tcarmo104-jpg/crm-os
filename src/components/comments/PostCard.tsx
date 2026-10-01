'use client';

import { useState } from 'react';
import { STATUS_LABEL, canReplyPrivately, type CommentStatus } from '@/lib/comments';
import { ConfirmButton, Notice } from '@/components/ui';
import { InboxAvatar } from '@/components/inbox/Avatar';
import { deleteCommentAction, replyPrivateAction, replyPublicAction, toggleHiddenAction } from '@/app/(app)/comments/actions';
import type { SocialCommentRow, SocialPostRow } from '@/repositories/social-comments';

function formatWhen(iso: string, locale: string, tz: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso));
}

function CommentRow({ c, canManage, orgLocale, orgTimezone, replies }: { c: SocialCommentRow; canManage: boolean; orgLocale: string; orgTimezone: string; replies?: SocialCommentRow[] }) {
  const [open, setOpen] = useState<'public' | 'private' | null>(null);
  const deleted = c.status === 'deleted';
  const privateOk = canReplyPrivately(c.occurredAt);

  return (
    <li className={`comment-row${c.status === 'hidden' ? ' comment-row--hidden' : ''}${deleted ? ' comment-row--deleted' : ''}`}>
      <InboxAvatar name={c.authorName} size={32} />
      <div className="comment-body">
        <div className="comment-head">
          <strong>{c.authorName}</strong>
          <span className="small muted">{formatWhen(c.occurredAt, orgLocale, orgTimezone)}</span>
          {c.status !== 'visible' ? <span className={`badge ${c.status === 'hidden' ? 'badge-neutral' : 'badge-danger'}`}>{STATUS_LABEL[c.status as CommentStatus]}</span> : null}
        </div>
        <p className={deleted ? 'muted' : undefined}>{c.message ?? <em className="muted">Sin texto (puede ser una imagen o un sticker)</em>}</p>

        {c.repliedPubliclyText ? <p className="comment-reply-echo"><strong>Tu respuesta pública:</strong> {c.repliedPubliclyText}</p> : null}
        {c.privateReplyAt ? <p className="hint">Ya le respondiste en privado — <a href="/inbox">verlo en el Inbox</a>.</p> : null}

        {canManage && !deleted ? (
          <div className="comment-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(open === 'public' ? null : 'public')}>Responder en público</button>
            {privateOk ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(open === 'private' ? null : 'private')}>Responder en privado</button> : <span className="hint">Ya no se puede responder en privado (pasaron 7 días)</span>}
            <form action={toggleHiddenAction} style={{ display: 'inline' }}>
              <input type="hidden" name="commentId" value={c.id} /><input type="hidden" name="hidden" value={c.status === 'hidden' ? '0' : '1'} />
              <button type="submit" className="btn btn-ghost btn-sm">{c.status === 'hidden' ? 'Mostrar' : 'Ocultar'}</button>
            </form>
            <form action={deleteCommentAction} style={{ display: 'inline' }}>
              <input type="hidden" name="commentId" value={c.id} />
              <ConfirmButton message="¿Eliminar este comentario de verdad? No se puede deshacer." className="btn btn-ghost btn-sm">Eliminar</ConfirmButton>
            </form>
          </div>
        ) : null}

        {open === 'public' ? (
          <form action={replyPublicAction} className="comment-reply-form">
            <input type="hidden" name="commentId" value={c.id} />
            <textarea name="message" className="input" rows={2} maxLength={2000} placeholder="Escribe tu respuesta pública…" autoFocus />
            <button type="submit" className="btn btn-primary btn-sm">Publicar respuesta</button>
          </form>
        ) : null}
        {open === 'private' ? (
          <form action={replyPrivateAction} className="comment-reply-form">
            <input type="hidden" name="commentId" value={c.id} />
            <textarea name="message" className="input" rows={2} maxLength={2000} placeholder="Escribe tu respuesta privada… (va a caer en tu Inbox)" autoFocus />
            <button type="submit" className="btn btn-primary btn-sm">Enviar en privado</button>
          </form>
        ) : null}

        {replies && replies.length > 0 ? (
          <ul className="comment-list comment-list--nested">
            {replies.map((r) => <CommentRow key={r.id} c={r} canManage={canManage} orgLocale={orgLocale} orgTimezone={orgTimezone} />)}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

export function PostCard({ post, comments, canManage, orgLocale, orgTimezone }: { post: SocialPostRow; comments: SocialCommentRow[]; canManage: boolean; orgLocale: string; orgTimezone: string }) {
  const topLevel = comments.filter((c) => !c.parentExternalId);
  const repliesOf = (externalId: string) => comments.filter((c) => c.parentExternalId === externalId);

  return (
    <section className="panel" aria-label="Publicación">
      <div className="panel-head">
        <div>
          <p className="small muted">{post.caption ? post.caption.slice(0, 140) : 'Publicación'}</p>
          {post.permalink ? <a href={post.permalink} target="_blank" rel="noreferrer" className="small">Ver en Meta ↗</a> : null}
        </div>
        <span className="small muted">{comments.length} {comments.length === 1 ? 'comentario' : 'comentarios'}</span>
      </div>
      {topLevel.length === 0 ? <p className="muted">Sin comentarios en esta publicación.</p> : (
        <ul className="comment-list">
          {topLevel.map((c) => <CommentRow key={c.id} c={c} canManage={canManage} orgLocale={orgLocale} orgTimezone={orgTimezone} replies={repliesOf(c.externalId)} />)}
        </ul>
      )}
    </section>
  );
}
