import Link from 'next/link';
import { CHANNEL_LABEL, inboxHref, type ChannelKind, type InboxQuery } from '@/lib/inbox-view';
import { AssignSelect } from './AssignSelect';
import { InboxAvatar } from './Avatar';
import { ContextToggle } from './ContextToggle';
import { Ico } from './icons';

type Action = (fd: FormData) => Promise<void>;

export function ChatHeader({
  query, conversationId, customerId, name, phone, channel, status, needsReply, ownerId, ownerName, advisors, canAssign, canUpdate, actions,
}: {
  query: InboxQuery; conversationId: string; customerId: string; name: string; phone: string; channel: ChannelKind; status: 'open' | 'closed';
  needsReply: boolean; ownerId: string | null; ownerName: string | null; advisors: { id: string; name: string }[]; canAssign: boolean; canUpdate: boolean;
  actions: { assign: Action; status: Action };
}) {
  return (
    <header className="ib-chat-head">
      <Link href={inboxHref(query, { c: '' })} scroll={false} className="ib-icon-btn ib-only-mobile" aria-label="Volver a la lista de conversaciones"><Ico name="chevronLeft" size={20} /></Link>
      <InboxAvatar name={name} channel={channel} size={40} />
      <div className="ib-chat-id">
        <h2 className="ib-chat-name"><Link href={`/customers/${customerId}`} title="Abrir la ficha completa del cliente">{name}</Link></h2>
        <p className="ib-chat-sub">
          <span>{CHANNEL_LABEL[channel]}</span>{phone ? <><span aria-hidden="true">·</span><span>{phone}</span></> : null}
          <span className={`ib-status ib-status--${status}`}>{status === 'open' ? (needsReply ? 'Pendiente' : 'Abierta') : 'Cerrada'}</span>
        </p>
      </div>
      <div className="ib-chat-actions">
        {canAssign ? (
          <AssignSelect key={`${conversationId}-${ownerId ?? 'none'}`} action={actions.assign} customerId={customerId} conversationId={conversationId} current={ownerId} options={advisors} />
        ) : (
          <span className="ib-owner-chip" title="Asesor asignado"><Ico name="user" size={14} /> {ownerName ?? 'Sin asignar'}</span>
        )}
        {canUpdate ? (
          <form action={actions.status}>
            <input type="hidden" name="conversationId" value={conversationId} /><input type="hidden" name="status" value={status === 'open' ? 'closed' : 'open'} />
            <button type="submit" className="ib-btn ib-btn--ghost">{status === 'open' ? 'Cerrar' : 'Reabrir'}</button>
          </form>
        ) : null}
        <ContextToggle variant="header" />
      </div>
    </header>
  );
}
