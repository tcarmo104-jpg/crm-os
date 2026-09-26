import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listTasks } from '@/repositories/tasks';
import { listConversations } from '@/repositories/inbox';
import { dueBucket } from '@/lib/tasks';
import { buildActionQueue } from '@/lib/today';
import { Icon } from '@/components/Icon';
import { completeTaskAction } from '../tasks/actions';

export const metadata: Metadata = { title: 'Mi próxima acción' };

const KIND_ICON: Record<string, string> = { task_overdue: 'check', reply: 'inbox', task_today: 'check' };

export default async function NextActionPage() {
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  const canTasks = can(session, 'tasks:read');
  const canInbox = can(session, 'conversations:read');

  const [openTasks, pendingConvs] = await Promise.all([
    canTasks ? listTasks(db, { orgId: org.orgId, statuses: ['open', 'in_progress'], assigneeId: session.user.id, limit: 300 }) : Promise.resolve([]),
    canInbox ? listConversations(db, { orgId: org.orgId, filter: 'reply', limit: 50 }).then((r) => r.items) : Promise.resolve([]),
  ]);
  const now = new Date();
  const overdueTasks = openTasks.filter((t) => dueBucket(t.dueAt, now, org.orgTimezone) === 'overdue').map((t) => ({ id: t.id, title: t.title, customerId: t.customerId, dueAt: t.dueAt }));
  const todayTasks = openTasks.filter((t) => dueBucket(t.dueAt, now, org.orgTimezone) === 'today').map((t) => ({ id: t.id, title: t.title, customerId: t.customerId, dueAt: t.dueAt }));
  const pendingReplies = pendingConvs.map((c) => ({ id: c.id, name: c.contactName ?? c.threadKey, lastMessageAt: c.lastMessageAt }));

  const queue = buildActionQueue({ overdueTasks, todayTasks, pendingReplies });
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: org.orgTimezone });
  const back = '/next-action';

  return (
    <>
      <header className="page-head">
        <h1>Mi próxima acción</h1>
        <p className="muted">Todo lo pendiente, en el orden en que conviene resolverlo: primero lo vencido, luego quien espera tu respuesta, luego lo de hoy.</p>
      </header>

      {queue.length === 0 ? (
        <div className="empty-state">
          <span className="empty-ico"><Icon name="check" size={22} /></span>
          <strong>No tienes nada pendiente ahora</strong>
          <p>Cuando tengas tareas vencidas, de hoy, o conversaciones sin responder, aparecerán aquí en orden.</p>
        </div>
      ) : (
        <ol className="queue-list">
          {queue.map((item, i) => (
            <li key={`${item.kind}-${item.href}-${i}`} className={`queue-item queue-item--${item.tone}`}>
              <span className="queue-num">{i + 1}</span>
              <span className="queue-ico"><Icon name={KIND_ICON[item.kind] ?? 'bolt'} size={16} /></span>
              <div className="queue-body">
                <Link href={item.href} className="queue-title">{item.title}</Link>
                <span className="queue-detail">{item.detail}{item.at ? ` · ${fmt.format(new Date(item.at))}` : ''}</span>
              </div>
              {item.kind !== 'reply' ? (
                <form action={completeTaskAction} className="queue-acts">
                  <input type="hidden" name="taskId" value={item.id} />
                  <input type="hidden" name="returnTo" value={back} />
                  <button className="btn btn-secondary btn-sm" type="submit">Completar</button>
                  <Link href={item.href} className="btn btn-ghost btn-sm">Abrir</Link>
                </form>
              ) : (
                <Link href={item.href} className="btn btn-primary btn-sm">Responder</Link>
              )}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
