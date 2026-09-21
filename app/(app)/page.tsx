import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listTeams } from '@/repositories/teams';
import { listMembers } from '@/repositories/members';
import { listPending } from '@/repositories/invitations';
import { countCustomers } from '@/repositories/customers';
import { listTasks } from '@/repositories/tasks';
import { listPipelines } from '@/repositories/pipelines';
import { listConversations, tabCounts } from '@/repositories/inbox';
import { loadBoard } from '@/repositories/opportunities-board';
import { kpis, parseKanbanQuery, initials } from '@/lib/kanban';
import { formatMoney } from '@/lib/money';
import { nextAction, stageFunnel, timeAgo } from '@/lib/today';
import type { IconName } from '@/lib/nav';
import { groupTasks } from '@/lib/tasks';
import { Icon } from '@/components/Icon';

export const metadata: Metadata = { title: 'Hoy' };

function greeting(timeZone: string): string {
  let hour = new Date().getHours();
  try {
    hour = Number(new Intl.DateTimeFormat('es', { hour: 'numeric', hour12: false, timeZone }).format(new Date())) % 24;
  } catch { /* zona horaria inválida: usa la del servidor */ }
  if (hour < 12) return 'Buenos días';
  if (hour < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

export default async function TodayPage() {
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  const canManage = can(session, 'users:manage');
  const canOpps = can(session, 'opportunities:read');
  const canInbox = can(session, 'conversations:read');
  const canTasks = can(session, 'tasks:read');

  const [teams, members, pending, customerCount, openTasks, pipelines, counts, recent] = await Promise.all([
    listTeams(db, org.orgId),
    listMembers(db, org.orgId),
    canManage ? listPending(db, org.orgId) : Promise.resolve([]),
    can(session, 'customers:read') ? countCustomers(db, org.orgId) : Promise.resolve(0),
    canTasks ? listTasks(db, { orgId: org.orgId, status: 'open', assigneeId: session.user.id, limit: 200 }) : Promise.resolve([]),
    canOpps ? listPipelines(db, org.orgId).catch(() => []) : Promise.resolve([]),
    canInbox ? tabCounts(db, org.orgId).catch(() => ({ unread: 0, pending: 0, unassigned: 0 })) : Promise.resolve({ unread: 0, pending: 0, unassigned: 0 }),
    canInbox ? listConversations(db, { orgId: org.orgId, filter: 'open', limit: 5 }).then((r) => r.items).catch(() => []) : Promise.resolve([]),
  ]);
  const pipeline = pipelines.find((p) => p.isDefault) ?? pipelines[0];
  const board = pipeline ? await loadBoard(db, { orgId: org.orgId, pipeline, query: parseKanbanQuery({}), members }).catch(() => null) : null;
  const cards = board?.cards ?? [];
  const k = kpis(cards);
  const funnel = pipeline ? stageFunnel(pipeline.stages, cards) : [];
  const currency = cards.find((c) => c.currency)?.currency ?? 'COP';
  const money = (n: number) => formatMoney(n, currency, org.orgLocale);

  const buckets = groupTasks(openTasks, new Date(), org.orgTimezone);
  const overdue = buckets.find((b) => b.bucket === 'overdue')?.tasks ?? [];
  const today = buckets.find((b) => b.bucket === 'today')?.tasks ?? [];
  const urgent = [...overdue, ...today];
  const fmtTime = new Intl.DateTimeFormat('es', { dateStyle: 'short', timeStyle: 'short', timeZone: org.orgTimezone });
  const fmtDay = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long', timeZone: org.orgTimezone });

  const firstPending = recent.find((c) => c.needsReply) ?? null;
  const next = nextAction({
    overdue: overdue.map((t) => ({ title: t.title, customerId: t.customerId })), today: today.map((t) => ({ title: t.title, customerId: t.customerId })),
    pendingReplies: counts.pending, firstPending: firstPending ? { id: firstPending.id, name: firstPending.contactName ?? firstPending.threadKey } : null,
    customerCount, openOpportunities: k.open,
    can: { tasks: canTasks, inbox: canInbox, customers: can(session, 'customers:read'), opportunities: canOpps },
  });

  const firstName = (session.user.fullName ?? '').split(' ')[0];
  const steps = [
    { done: true, label: 'Crear la organización', href: null as string | null },
    { done: teams.length > 0, label: 'Crear un equipo', href: '/settings/teams' },
    { done: members.length > 1 || pending.length > 0, label: 'Invitar a alguien', href: '/settings/members' },
    { done: customerCount > 0, label: 'Importar o crear tus clientes', href: '/leads/import' },
  ];
  const stepsLeft = steps.filter((x) => !x.done).length;
  const quick = ([
    { href: '/customers/new', icon: 'users', label: 'Nuevo cliente', hint: 'Crea un contacto', show: can(session, 'customers:create') },
    { href: '/opportunities/new', icon: 'target', label: 'Nueva oportunidad', hint: 'Abre una posible venta', show: can(session, 'opportunities:create') },
    { href: '/leads/import', icon: 'file', label: 'Importar clientes', hint: 'Desde un archivo', show: can(session, 'customers:create') },
    { href: '/settings/connections', icon: 'plug', label: 'Conectar un canal', hint: 'WhatsApp, Instagram, Gmail', show: can(session, 'settings:manage') },
    { href: '/settings/members', icon: 'team', label: 'Invitar a alguien', hint: 'Suma a tu equipo', show: canManage },
  ] satisfies { href: string; icon: IconName; label: string; hint: string; show: boolean }[]).filter((q) => q.show);

  return (
    <>
      <header className="page-head">
        <h1>{greeting(org.orgTimezone)}{firstName ? `, ${firstName}` : ''}</h1>
        <p className="muted">{org.orgName} · <span className="cap">{fmtDay.format(new Date())}</span></p>
      </header>

      {/* Nivel 1 · lo que importa de un vistazo */}
      <section className="kpi-grid" aria-label="Indicadores principales">
        {canOpps ? <Kpi href="/opportunities" label="Valor del pipeline" value={money(k.pipelineTotal)} sub={`${k.open} ${k.open === 1 ? 'oportunidad abierta' : 'oportunidades abiertas'}`} tone="primary" /> : null}
        {canOpps ? <Kpi href="/opportunities" label="Ganado · 30 días" value={money(k.wonAmount)} sub={`${k.won} ${k.won === 1 ? 'venta cerrada' : 'ventas cerradas'}`} tone="ok" /> : null}
        {canInbox ? <Kpi href="/inbox" label="Por responder" value={String(counts.pending)} sub={counts.pending === 1 ? 'conversación esperando' : 'conversaciones esperando'} tone={counts.pending > 0 ? 'warn' : 'neutral'} /> : null}
        {canTasks ? <Kpi href="/tasks" label="Tareas para hoy" value={String(urgent.length)} sub={overdue.length > 0 ? `${overdue.length} vencidas` : 'al día'} tone={overdue.length > 0 ? 'danger' : 'neutral'} /> : null}
      </section>

      {/* Nivel 2 · el embudo y qué hacer ahora */}
      <div className="dash-grid">
        {canOpps ? (
          <section className="panel" aria-labelledby="funnel-title">
            <div className="panel-head">
              <h2 id="funnel-title">Embudo de ventas</h2>
              <Link className="btn btn-ghost btn-sm" href="/opportunities">Ver tablero</Link>
            </div>
            {funnel.length === 0 || funnel.every((f) => f.count === 0) ? (
              <Empty icon="target" title="Aún no hay oportunidades abiertas" text="Cuando abras oportunidades verás aquí cuánto valor hay en cada etapa." href={can(session, 'opportunities:create') ? '/opportunities/new' : undefined} cta="Nueva oportunidad" />
            ) : (
              <ul className="funnel">
                {funnel.map((f) => (
                  <li key={f.id} className="funnel-row">
                    <div className="funnel-top"><span className="funnel-name">{f.name}</span><span className="funnel-val">{money(f.amount)}</span></div>
                    <div className="funnel-track" role="img" aria-label={`${f.name}: ${f.count} oportunidades, ${money(f.amount)}`}><span className="funnel-fill" style={{ width: `${Math.max(f.pct, f.count > 0 ? 3 : 0)}%` }} /></div>
                    <span className="funnel-count">{f.count} {f.count === 1 ? 'oportunidad' : 'oportunidades'}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        <section className={`next-action next-action--${next.tone}`} aria-labelledby="na-title">
          <span className="eyebrow">{next.eyebrow}</span>
          <h2 id="na-title">{next.title}</h2>
          <p>{next.detail}</p>
          {next.href && next.cta ? <Link className="btn btn-primary" href={next.href}>{next.cta}</Link> : null}
        </section>
      </div>

      {/* Nivel 3 · actividad reciente */}
      <div className="dash-grid">
        {canInbox ? (
          <section className="panel" aria-labelledby="recent-title">
            <div className="panel-head">
              <h2 id="recent-title">Últimas conversaciones</h2>
              <Link className="btn btn-ghost btn-sm" href="/inbox">Abrir Inbox</Link>
            </div>
            {recent.length === 0 ? (
              <Empty icon="inbox" title="Todavía no hay conversaciones" text="Los mensajes de tus clientes aparecerán aquí en cuanto conectes un canal." href={can(session, 'settings:manage') ? '/settings/connections' : undefined} cta="Conectar un canal" />
            ) : (
              <ul className="row-list">
                {recent.map((c) => {
                  const name = c.contactName ?? c.threadKey;
                  return (
                    <li key={c.id}>
                      <Link className="row-item" href={`/inbox?c=${c.id}`}>
                        <span className="avatar" aria-hidden="true">{initials(name)}</span>
                        <span className="row-main"><strong>{name}</strong><small>{c.lastMessagePreview ?? 'Sin mensajes'}</small></span>
                        <span className="row-side">
                          <small>{timeAgo(c.lastMessageAt, new Date(), 'es', org.orgTimezone)}</small>
                          {c.unreadCount > 0 ? <span className="badge badge-info">{c.unreadCount}</span> : c.needsReply ? <span className="badge badge-warn">Responder</span> : null}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}

        {canTasks ? (
          <section className="panel" aria-labelledby="today-tasks">
            <div className="panel-head">
              <h2 id="today-tasks">Tus tareas de hoy</h2>
              <Link className="btn btn-ghost btn-sm" href="/tasks">Ver todas ({openTasks.length})</Link>
            </div>
            {urgent.length === 0 ? (
              <Empty icon="check" title={openTasks.length === 0 ? 'No tienes tareas pendientes' : 'Nada vence hoy ni está atrasado'} text="Las tareas que agendes desde un cliente u oportunidad aparecerán aquí." />
            ) : (
              <ul className="row-list">
                {urgent.slice(0, 6).map((t) => (
                  <li key={t.id} className="row-item row-item--static">
                    <span className={`dot-status ${overdue.includes(t) ? 'is-danger' : 'is-warn'}`} aria-hidden="true" />
                    <span className="row-main">{t.customerId ? <Link href={`/customers/${t.customerId}`}><strong>{t.title}</strong></Link> : <strong>{t.title}</strong>}</span>
                    <span className={overdue.includes(t) ? 'badge badge-danger' : 'badge badge-neutral'}>{overdue.includes(t) ? 'Vencida · ' : ''}{t.dueAt ? fmtTime.format(new Date(t.dueAt)) : 'Sin hora'}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>

      {/* Nivel 4 · acciones rápidas */}
      {quick.length > 0 ? (
        <section aria-labelledby="quick-title" className="stack">
          <h2 id="quick-title" className="section-title">Acciones rápidas</h2>
          <div className="quick-grid">
            {quick.map((q) => (
              <Link key={q.href} href={q.href} className="quick-tile">
                <span className="quick-ico"><Icon name={q.icon} size={20} /></span>
                <span className="quick-text"><strong>{q.label}</strong><small>{q.hint}</small></span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {stepsLeft > 0 ? (
        <section className="panel" aria-labelledby="steps-title">
          <div className="panel-head">
            <h2 id="steps-title">Primeros pasos</h2>
            <span className="badge badge-info">{steps.length - stepsLeft} de {steps.length}</span>
          </div>
          <ul className="checklist">
            {steps.map((st) => (
              <li key={st.label} className={st.done ? 'is-done' : undefined}>
                <span className="check" aria-hidden="true">{st.done ? <Icon name="check" size={14} /> : null}</span>
                <span className="check-label">
                  {st.href && !st.done ? <Link href={st.href}>{st.label}</Link> : st.label}
                  <span className="sr-only">{st.done ? ' (completado)' : ' (pendiente)'}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/** Indicador principal: cifra grande, etiqueta pequeña y una línea de contexto. Todo el bloque lleva al módulo. */
function Kpi({ href, label, value, sub, tone }: { href: string; label: string; value: string; sub: string; tone: 'primary' | 'ok' | 'warn' | 'danger' | 'neutral' }) {
  return (
    <Link href={href} className={`kpi kpi--${tone}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      <span className="kpi-sub">{sub}</span>
    </Link>
  );
}

/** Estado vacío: qué es esto, por qué está vacío y qué hacer. */
function Empty({ icon, title, text, href, cta }: { icon: IconName; title: string; text: string; href?: string; cta?: string }) {
  return (
    <div className="empty-state">
      <span className="empty-ico"><Icon name={icon} size={22} /></span>
      <strong>{title}</strong>
      <p>{text}</p>
      {href && cta ? <Link className="btn btn-secondary btn-sm" href={href}>{cta}</Link> : null}
    </div>
  );
}
