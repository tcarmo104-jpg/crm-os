import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { INBOX_CONTEXT_COOKIE, contactLabel, inboxHref, parseContextCookie, parseInboxQuery, replyWindowMs, type ChannelKind } from '@/lib/inbox-view';
import { buildThread } from '@/lib/thread';
import { describeEvent } from '@/lib/timeline';
import {
  getConversation, listChannels, listMessages, listQuickReplies, listTags, listTemplates, markRead, searchConversations, tabCounts, tagsByCustomer,
} from '@/repositories/inbox';
import { loadCustomerContext } from '@/repositories/inbox-context';
import { getCustomersByIds, timeline } from '@/repositories/customers';
import { listMembers } from '@/repositories/members';
import { AutoRefresh } from '@/components/AutoRefresh';
import { Notice } from '@/components/ui';
import { ChatHeader } from '@/components/inbox/ChatHeader';
import { Composer } from '@/components/inbox/Composer';
import { ContextPanel } from '@/components/inbox/ContextPanel';
import { ContextToggle } from '@/components/inbox/ContextToggle';
import { ConversationList, type ListRow } from '@/components/inbox/ConversationList';
import { Ico } from '@/components/inbox/icons';
import { Thread } from '@/components/inbox/Thread';
import {
  addTagAction, assignOwnerAction, createQuickReplyAction, deleteQuickReplyAction, removeTagAction, sendMessageAction, sendNoteAction,
  sendTemplateAction, setConversationStatusAction,
} from './actions';
import './inbox.css';

export const metadata: Metadata = { title: 'Inbox' };

const DAY = 24 * 60 * 60 * 1000;
const SYSTEM_EVENTS = new Set(['conversation.opened', 'conversation.reopened', 'customer.assigned', 'customer.dnc_set', 'customer.dnc_cleared']);

export default async function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const query = parseInboxQuery(sp);
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  const canRead = can(session, 'conversations:read');
  const canUpdate = can(session, 'conversations:update');
  const canManage = can(session, 'settings:manage');
  const canEditCustomer = can(session, 'customers:update');
  const canAssign = session.permissions['customers:update'] === 'org';
  const userId = session.user.id;

  if (!canRead) {
    return <div className="ib-noaccess"><Notice kind="error">Tu rol no tiene acceso al Inbox.</Notice></div>;
  }

  // Abrir una conversación la marca como leída (antes de listar, para que el contador de la lista ya salga en 0).
  const conv = query.c ? await getConversation(db, query.c) : null;
  if (conv?.unread && canUpdate) await markRead(db, conv.id).catch(() => undefined);
  const conversation = conv && conv.unread && canUpdate ? { ...conv, unread: false, unreadCount: 0 } : conv;

  const limRaw = Number(Array.isArray(sp.lim) ? sp.lim[0] : sp.lim);
  const lim = Number.isFinite(limRaw) ? Math.min(Math.max(Math.round(limRaw), 40), 200) : 40;

  const [page, channels, members, tags, counts, flash, jar] = await Promise.all([
    searchConversations(db, { orgId: org.orgId, userId, query, limit: lim }),
    listChannels(db, org.orgId), listMembers(db, org.orgId), listTags(db, org.orgId), tabCounts(db, org.orgId),
    readFlash(), cookies(),
  ]);
  const ctxState = parseContextCookie(jar.get(INBOX_CONTEXT_COOKIE)?.value);

  const memberName = (id: string | null | undefined) => {
    const m = members.find((x) => x.userId === id);
    return id ? (m?.fullName ?? m?.email ?? 'Alguien') : 'Sin asignar';
  };
  const advisors = members.map((m) => ({ id: m.userId, name: m.fullName ?? m.email ?? 'Alguien' }));
  const channelKind = new Map<string, ChannelKind>(channels.map((c) => [c.id, c.kind]));

  const custIds = [...new Set(page.items.map((c) => c.customerId))];
  const [customers, tagMap] = await Promise.all([getCustomersByIds(db, custIds), tagsByCustomer(db, custIds)]);
  const custName = new Map(customers.map((c) => [c.id, c.fullName]));
  const rows: ListRow[] = page.items.map((c) => ({
    conv: conversation && c.id === conversation.id ? conversation : c,
    name: custName.get(c.customerId) ?? c.contactName ?? (channelKind.get(c.channelId) === 'whatsapp' ? `+${c.threadKey}` : c.threadKey),
    ownerName: c.ownerId ? memberName(c.ownerId) : null,
    tags: tagMap.get(c.customerId) ?? [],
    channel: channelKind.get(c.channelId) ?? 'whatsapp',
  }));
  const base = inboxHref(query, { c: query.c });
  const nextHref = page.nextCursor && lim < 200 ? `${base}${base.includes('?') ? '&' : '?'}lim=${lim + 40}` : null;

  // ---- Conversación abierta ----------------------------------------------------------------------------------
  let chat: React.ReactNode = null;
  let context: React.ReactNode = null;
  if (query.c) {
    const ctx = conversation ? await loadCustomerContext(db, org.orgId, conversation.customerId) : null;
    if (!conversation || !ctx) {
      chat = (
        <div className="ib-blank">
          <Ico name="inbox" size={40} />
          <h2>No encontramos esta conversación</h2>
          <p>Puede que el enlace esté incompleto o que sea de un cliente que no tienes asignado.</p>
          <a className="ib-btn ib-btn--primary" href={inboxHref(query, { c: '' })}>Volver a la lista</a>
        </div>
      );
    } else {
      const [messages, events, quick, templates] = await Promise.all([
        listMessages(db, conversation.id, 300),
        timeline(db, conversation.customerId, 100).catch(() => []),
        canUpdate ? listQuickReplies(db, org.orgId) : Promise.resolve([]),
        canUpdate ? listTemplates(db, org.orgId) : Promise.resolve([]),
      ]);
      const items = buildThread(
        messages,
        ctx.notes.map((n) => ({ id: n.id, occurredAt: n.occurredAt, summary: n.summary, createdBy: n.createdBy })),
        events.filter((e) => SYSTEM_EVENTS.has(e.type)).map((e) => ({ id: e.id, occurredAt: e.occurredAt, text: describeEvent(e, memberName).title })),
      );
      const channel = channels.find((c) => c.id === conversation.channelId);
      const kindOfConv = channelKind.get(conversation.channelId) ?? 'whatsapp';
      const closesAt = conversation.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() + replyWindowMs(kindOfConv) : 0;
      const windowOpen = closesAt > Date.now();
      const closesLabel = new Intl.DateTimeFormat('es', { timeZone: org.orgTimezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(closesAt));
      const name = ctx.customer.fullName;
      const phone = contactLabel(kindOfConv, conversation.threadKey, ctx.identifiers.find((i) => i.type === 'phone')?.value.replace(/^\+/, '') ?? null);
      const mine = messages.filter((m) => m.direction === 'outbound').length + ctx.notes.length;

      chat = (
        <>
          <ChatHeader
            query={query} conversationId={conversation.id} customerId={ctx.customer.id} name={name} phone={phone} channel={kindOfConv}
            status={conversation.status} needsReply={conversation.needsReply} ownerId={ctx.customer.ownerId} ownerName={ctx.customer.ownerId ? memberName(ctx.customer.ownerId) : null}
            advisors={advisors} canAssign={canAssign} canUpdate={canUpdate} actions={{ assign: assignOwnerAction, status: setConversationStatusAction }}
          />
          {flash ? <div className="ib-flash"><Notice kind={flash.kind}>{flash.message}</Notice></div> : null}
          <Thread items={items} timeZone={org.orgTimezone} nameOf={memberName} resetKey={conversation.id} emptyText="Aún no hay mensajes en esta conversación." />
          <Composer
            key={`${conversation.id}:${mine}`} conversationId={conversation.id} customerId={ctx.customer.id}
            channel={kindOfConv} canReply={canUpdate} windowOpen={windowOpen} windowClosesLabel={closesLabel} dnc={ctx.customer.doNotContact} paused={channel?.status === 'paused'}
            quickReplies={quick} templates={templates.filter((t) => t.channelId === conversation.channelId && t.status === 'approved').map((t) => ({ id: t.id, name: t.name, body: t.body, paramCount: t.paramCount }))}
            actions={{ send: sendMessageAction, note: sendNoteAction, template: sendTemplateAction, createQuick: createQuickReplyAction, deleteQuick: deleteQuickReplyAction }}
          />
          <ContextToggle variant="edge" initialOpen={ctxState === 'open'} />
        </>
      );
      context = (
        <ContextPanel
          ctx={ctx} allTags={tags} ownerName={ctx.customer.ownerId ? memberName(ctx.customer.ownerId) : null} timeZone={org.orgTimezone}
          conversationId={conversation.id} canEditCustomer={canEditCustomer} actions={{ addTag: addTagAction, removeTag: removeTagAction }} nameOf={memberName}
        />
      );
    }
  } else {
    chat = (
      <div className="ib-blank">
        <Ico name="inbox" size={40} />
        <h2>Selecciona una conversación</h2>
        <p>Elige un chat de la lista para verlo aquí junto con la ficha del cliente.</p>
        {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}
      </div>
    );
  }

  return (
    <div className="ib" data-context={ctxState} data-sheet="closed" data-view={query.c ? 'chat' : 'list'}>
      <AutoRefresh seconds={12} />
      <ConversationList
        query={query} rows={rows} nextHref={nextHref} counts={counts} tags={tags} advisors={advisors} channels={channels}
        timeZone={org.orgTimezone} hasChannels={channels.length > 0} canManageChannels={canManage}
      />
      <section className="ib-chat" aria-label="Conversación">{chat}</section>
      {context}
    </div>
  );
}
