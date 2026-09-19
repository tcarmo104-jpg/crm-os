import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { listChannels, listConversations, type InboxFilter } from '@/repositories/inbox';
import { getCustomersByIds } from '@/repositories/customers';
import { listMembers } from '@/repositories/members';
import { AutoRefresh } from '@/components/AutoRefresh';
import { Notice } from '@/components/ui';

export const metadata: Metadata = { title: 'Inbox' };

const TABS: { key: InboxFilter; label: string }[] = [
  { key: 'reply', label: 'Sin responder' }, { key: 'open', label: 'Abiertas' }, { key: 'unassigned', label: 'Sin asignar' }, { key: 'closed', label: 'Cerradas' },
];

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ f?: string; cursor?: string }> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  const filter = (TABS.find((t) => t.key === sp.f)?.key ?? 'reply') as InboxFilter;
  const canRead = can(session, 'conversations:read');

  const [page, channels, members, flash] = await Promise.all([
    canRead ? listConversations(db, { orgId: org.orgId, filter, cursor: sp.cursor }) : Promise.resolve({ items: [], nextCursor: null }),
    canRead ? listChannels(db, org.orgId) : Promise.resolve([]),
    listMembers(db, org.orgId), readFlash(),
  ]);
  const customers = await getCustomersByIds(db, [...new Set(page.items.map((c) => c.customerId))]);
  const cName = new Map(customers.map((c) => [c.id, c.fullName]));
  const nameOf = (uid: string | null) => { const m = members.find((x) => x.userId === uid); return uid ? (m?.fullName ?? m?.email ?? 'Alguien') : 'Sin asignar'; };
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'short', timeStyle: 'short', timeZone: org.orgTimezone });
  const canManage = can(session, 'settings:manage');

  return (
    <>
      <AutoRefresh seconds={15} />
      <header className="page-head">
        <h1>Inbox</h1>
        <p className="muted">Conversaciones de WhatsApp con tus clientes. Cada persona nueva que escribe se convierte en cliente y lead automáticamente.</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      {canRead && channels.length === 0 ? (
        <section className="panel">
          <div className="empty">
            <p><strong>Aún no hay un canal de WhatsApp conectado.</strong></p>
            {canManage ? <p><Link className="btn btn-primary" href="/settings/channels">Conectar WhatsApp</Link></p> : <p className="muted">Pide a un administrador que lo conecte en Configuración → Canales.</p>}
          </div>
        </section>
      ) : (
        <section className="panel" aria-labelledby="inbox-title">
          <div className="panel-head" style={{ flexWrap: 'wrap', gap: 10 }}>
            <h2 id="inbox-title">Conversaciones</h2>
            <nav className="tabs" aria-label="Filtro">
              {TABS.map((t) => <Link key={t.key} href={`/inbox?f=${t.key}`} aria-current={t.key === filter ? 'page' : undefined}>{t.label}</Link>)}
            </nav>
          </div>
          {page.items.length === 0 ? (
            <div className="empty"><p><strong>{filter === 'reply' ? 'No hay mensajes por responder. 🎉' : 'No hay conversaciones aquí.'}</strong></p></div>
          ) : page.items.map((c) => (
            <Link key={c.id} href={`/inbox/${c.id}`} className={`conv-row${c.unread ? ' unread' : ''}`}>
              {c.unread ? <span className="dot" aria-label="Sin leer" /> : <span className="dot" style={{ visibility: 'hidden' }} />}
              <span className="main">
                <span className="who">{cName.get(c.customerId) ?? c.contactName ?? `+${c.threadKey}`} {c.needsReply ? <span className="badge badge-warn">Sin responder</span> : null}</span>
                <span className="preview">{c.lastDirection === 'outbound' ? 'Tú: ' : ''}{c.lastMessagePreview ?? ''}</span>
                <span className="small muted">WhatsApp · {nameOf(c.ownerId)}</span>
              </span>
              <span className="when">{c.lastMessageAt ? fmt.format(new Date(c.lastMessageAt)) : ''}</span>
            </Link>
          ))}
          {page.nextCursor ? <p><Link className="btn btn-secondary" href={`/inbox?f=${filter}&cursor=${encodeURIComponent(page.nextCursor)}`}>Ver más</Link></p> : null}
        </section>
      )}
    </>
  );
}
