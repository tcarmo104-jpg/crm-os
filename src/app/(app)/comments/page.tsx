import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { listChannels } from '@/repositories/inbox';
import { listPosts, listCommentsForPosts } from '@/repositories/social-comments';
import { enrichPostIfNeeded } from '@/services/social-comments';
import { Notice } from '@/components/ui';
import { PostCard } from '@/components/comments/PostCard';
import { refreshPostsAction } from './actions';

export const metadata: Metadata = { title: 'Comentarios' };

export default async function CommentsPage({ searchParams }: { searchParams: Promise<{ canal?: string }> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'comments:read')) return <><header className="page-head"><h1>Comentarios</h1></header><Notice kind="error">No tienes acceso a este módulo.</Notice></>;
  const db = await createClient();
  const canManage = can(session, 'comments:manage');

  const [channels, flash] = await Promise.all([listChannels(db, org.orgId), readFlash()]);
  const socialChannels = channels.filter((c) => (c.kind === 'facebook' || c.kind === 'instagram') && c.connectionStatus === 'connected');
  const channel = socialChannels.find((c) => c.id === sp.canal) ?? socialChannels[0];

  if (socialChannels.length === 0) return (
    <>
      <header className="page-head"><h1>Comentarios</h1></header>
      <div className="empty-state">
        <strong>Todavía no tienes Facebook ni Instagram conectados.</strong>
        <p>Conéctalos desde Configuración → Conexiones para empezar a ver y responder comentarios aquí.</p>
      </div>
    </>
  );

  const posts = await listPosts(db, org.orgId, 20);
  const postsOfChannel = posts.filter((p) => p.channelId === channel!.id);
  // La primera vez que se vio una publicación solo se guardó su id: se completa su texto/enlace bajo demanda.
  for (const p of postsOfChannel.slice(0, 5)) if (!p.permalink) await enrichPostIfNeeded(db, p.id).catch(() => undefined);
  const refreshedPosts = postsOfChannel.length > 0 ? await listPosts(db, org.orgId, 20).then((all) => all.filter((p) => p.channelId === channel!.id)) : [];
  const comments = await listCommentsForPosts(db, org.orgId, refreshedPosts.map((p) => p.id));

  return (
    <>
      <header className="page-head">
        <h1>Comentarios</h1>
        <p className="muted">Los comentarios públicos de tus publicaciones de Facebook e Instagram. Responde en público, responde en privado (cae en tu Inbox), oculta o elimina.</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <div className="flt-bar">
        {socialChannels.length > 1 ? (
          <div className="view-toggle" role="tablist" aria-label="Canal">
            {socialChannels.map((c) => <a key={c.id} href={`/comments?canal=${c.id}`} aria-current={c.id === channel!.id ? 'page' : undefined}>{c.name}</a>)}
          </div>
        ) : <span className="muted small">{channel!.name}</span>}
        {canManage ? (
          <form action={refreshPostsAction.bind(null, channel!.id)} style={{ marginLeft: 'auto' }}>
            <button type="submit" className="btn btn-secondary btn-sm">Actualizar publicaciones</button>
          </form>
        ) : null}
      </div>

      {refreshedPosts.length === 0 ? (
        <div className="empty-state">
          <strong>Sin comentarios todavía.</strong>
          <p>En cuanto alguien comente una publicación, va a aparecer aquí solo. También puedes tocar «Actualizar publicaciones» para traer las más recientes.</p>
        </div>
      ) : (
        <div className="stack">
          {refreshedPosts.map((post) => (
            <PostCard key={post.id} post={post} comments={comments.filter((c) => c.postId === post.id)} canManage={canManage} orgLocale={org.orgLocale} orgTimezone={org.orgTimezone} />
          ))}
        </div>
      )}
    </>
  );
}
