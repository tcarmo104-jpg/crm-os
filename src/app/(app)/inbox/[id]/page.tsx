import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { getConversation, listChannels, listMessages, listTemplates, markRead } from '@/repositories/inbox';
import { getCustomer } from '@/repositories/customers';
import { listMembers } from '@/repositories/members';
import { uuidSchema } from '@/services/schemas';
import { AutoRefresh } from '@/components/AutoRefresh';
import { Notice, SubmitButton } from '@/components/ui';
import { sendMessageAction, sendTemplateAction, setConversationStatusAction } from '../actions';

export const metadata: Metadata = { title: 'Conversación' };

const STATUS_LABEL: Record<string, string> = { queued: 'En cola…', sending: 'Enviando…', sent: 'Enviado ✓', delivered: 'Entregado ✓✓', read: 'Leído ✓✓', failed: 'No se envió', received: '' };
const DAY = 24 * 60 * 60 * 1000;

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();

  const conv = await getConversation(db, id);
  if (!conv) notFound();
  const canReply = can(session, 'conversations:update');

  const [customer, messages, channels, templates, members, flash] = await Promise.all([
    getCustomer(db, conv.customerId), listMessages(db, id), listChannels(db, org.orgId),
    canReply ? listTemplates(db, org.orgId) : Promise.resolve([]), listMembers(db, org.orgId), readFlash(),
  ]);
  if (conv.unread && canReply) await markRead(db, id).catch(() => undefined);

  const channel = channels.find((c) => c.id === conv.channelId);
  const now = Date.now();
  const closesAt = conv.lastInboundAt ? new Date(conv.lastInboundAt).getTime() + DAY : 0;
  const windowOpen = closesAt > now;
  const dnc = customer?.doNotContact ?? false;
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: org.orgTimezone });
  const nameOf = (uid: string | null) => { const m = members.find((x) => x.userId === uid); return m?.fullName ?? m?.email ?? 'Alguien'; };
  const myTemplates = templates.filter((t) => t.channelId === conv.channelId && t.status === 'approved');
  const paused = channel?.status === 'paused';

  return (
    <>
      <AutoRefresh seconds={10} />
      <header className="page-head">
        <p className="small"><Link href="/inbox">← Inbox</Link></p>
        <h1>{customer?.fullName ?? conv.contactName ?? `+${conv.threadKey}`} <span className={`badge ${conv.status === 'open' ? 'badge-ok' : ''}`}>{conv.status === 'open' ? 'Abierta' : 'Cerrada'}</span></h1>
        <p className="muted">WhatsApp · +{conv.threadKey}{customer ? <> · <Link href={`/customers/${customer.id}`}>Ver ficha del cliente</Link></> : null}</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}
      {dnc ? <Notice kind="error">Este cliente pidió no ser contactado{customer?.dncReason ? ` (${customer.dncReason})` : ''}. Solo puedes responderle mientras la ventana de 24 h siga abierta, y no se le pueden enviar plantillas.</Notice> : null}
      {paused ? <Notice kind="error">El canal está en pausa: no se pueden enviar mensajes.</Notice> : null}

      <section className="panel" aria-labelledby="thread-title">
        <div className="panel-head"><h2 id="thread-title">Mensajes</h2></div>
        {messages.length === 0 ? <p className="muted">Aún no hay mensajes.</p> : (
          <div className="thread" role="log" aria-live="polite">
            {messages.map((m) => (
              <div key={m.id} className={`bubble${m.direction === 'outbound' ? ' out' : ''}${m.status === 'failed' ? ' failed' : ''}`}>
                {m.body}
                <span className="meta">
                  {fmt.format(new Date(m.occurredAt))}
                  {m.direction === 'outbound' ? ` · ${m.sentBy ? nameOf(m.sentBy) : 'Sistema'} · ${STATUS_LABEL[m.status] ?? m.status}` : ''}
                  {m.kind === 'template' ? ' · plantilla' : ''}
                </span>
                {m.status === 'failed' && m.error ? <span className="meta" style={{ color: '#c0392b' }}>{m.error}</span> : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {canReply ? (
        <section className="panel" aria-labelledby="reply-title">
          <div className="panel-head"><h2 id="reply-title">Responder</h2></div>
          {windowOpen ? (
            <>
              <p className="hint">Puedes escribir libremente hasta el {fmt.format(new Date(closesAt))} (24 h después del último mensaje del cliente).</p>
              <form action={sendMessageAction} className="reply-form">
                <input type="hidden" name="conversationId" value={id} />
                <label className="sr-only" htmlFor="body">Mensaje</label>
                <textarea id="body" name="body" className="input" rows={3} maxLength={4096} required placeholder="Escribe tu respuesta…" disabled={paused} />
                <div><SubmitButton pendingLabel="Enviando…">Enviar</SubmitButton></div>
              </form>
            </>
          ) : (
            <p className="hint"><strong>Pasaron más de 24 horas desde el último mensaje del cliente.</strong> WhatsApp solo permite enviar una plantilla aprobada hasta que el cliente responda.</p>
          )}

          {!dnc && !paused ? (
            myTemplates.length === 0 ? <p className="muted small">No hay plantillas aprobadas para este canal.{can(session, 'settings:manage') ? <> <Link href="/settings/channels">Agrégalas aquí</Link>.</> : null}</p> : myTemplates.map((t) => (
              <details key={t.id}>
                <summary>Enviar plantilla: <strong>{t.name}</strong></summary>
                <form action={sendTemplateAction} className="reply-form" style={{ marginTop: 8 }}>
                  <input type="hidden" name="conversationId" value={id} /><input type="hidden" name="templateId" value={t.id} />
                  <p className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{t.body}</p>
                  {Array.from({ length: t.paramCount }, (_, i) => (
                    <div className="field" key={i}>
                      <label className="label" htmlFor={`p${i + 1}-${t.id}`}>Dato {'{{'}{i + 1}{'}}'}</label>
                      <input id={`p${i + 1}-${t.id}`} name={`p${i + 1}`} className="input" maxLength={500} required />
                    </div>
                  ))}
                  <div><SubmitButton className="btn btn-secondary btn-sm" pendingLabel="Enviando…">Enviar plantilla</SubmitButton></div>
                </form>
              </details>
            ))
          ) : null}

          <form action={setConversationStatusAction} className="no-print">
            <input type="hidden" name="conversationId" value={id} /><input type="hidden" name="status" value={conv.status === 'open' ? 'closed' : 'open'} />
            <button className="btn btn-ghost btn-sm" type="submit">{conv.status === 'open' ? 'Cerrar conversación' : 'Reabrir conversación'}</button>
          </form>
        </section>
      ) : null}
    </>
  );
}
