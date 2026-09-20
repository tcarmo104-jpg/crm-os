import Form from 'next/form';
import Link from 'next/link';
import { INBOX_TABS, CHANNEL_LABEL, CHANNELS, activeAdvancedFilters, inboxHref, type ChannelKind, type InboxQuery } from '@/lib/inbox-view';
import { listTime } from '@/lib/thread';
import type { ChannelRow, ConversationRow, TagRow } from '@/lib/types';
import { InboxAvatar } from './Avatar';
import { Ico } from './icons';
import { TagPill } from './TagPill';

export interface ListRow { conv: ConversationRow; name: string; ownerName: string | null; tags: TagRow[]; channel: ChannelKind }

export function ConversationList({
  query, rows, nextHref, counts, tags, advisors, channels, timeZone, hasChannels, canManageChannels,
}: {
  query: InboxQuery; rows: ListRow[]; nextHref: string | null; counts: { unread: number; pending: number; unassigned: number };
  tags: TagRow[]; advisors: { id: string; name: string }[]; channels: ChannelRow[]; timeZone: string; hasChannels: boolean; canManageChannels: boolean;
}) {
  const advanced = activeAdvancedFilters(query);
  const now = new Date();
  const connected = new Set<string>(channels.map((c) => c.kind));
  const countOf = (k: string) => (k === 'unread' ? counts.unread : k === 'pending' ? counts.pending : k === 'unassigned' ? counts.unassigned : 0);

  return (
    <aside className="ib-list" aria-label="Conversaciones">
      <header className="ib-list-head">
        <h1 className="ib-title">Inbox</h1>
        <Form action="/inbox" className="ib-search" role="search">
          {query.tab !== 'all' ? <input type="hidden" name="f" value={query.tab} /> : null}
          {query.canal ? <input type="hidden" name="canal" value={query.canal} /> : null}
          {query.asesor ? <input type="hidden" name="asesor" value={query.asesor} /> : null}
          {query.etiqueta ? <input type="hidden" name="etiqueta" value={query.etiqueta} /> : null}
          {query.fecha ? <input type="hidden" name="fecha" value={query.fecha} /> : null}
          {query.estado ? <input type="hidden" name="estado" value={query.estado} /> : null}
          <span className="ib-search-ico"><Ico name="search" size={16} /></span>
          <label className="sr-only" htmlFor="ib-q">Buscar conversaciones</label>
          <input id="ib-q" name="q" type="search" defaultValue={query.q} placeholder="Buscar por nombre, teléfono o mensaje" className="ib-search-input" autoComplete="off" />
        </Form>

        <nav className="ib-tabs" aria-label="Filtrar conversaciones">
          {INBOX_TABS.map((t) => {
            const n = countOf(t.key);
            return (
              <Link key={t.key} href={inboxHref(query, { tab: t.key, c: query.c })} scroll={false} className={query.tab === t.key ? 'is-active' : ''} aria-current={query.tab === t.key ? 'page' : undefined}>
                {t.label}{n > 0 ? <span className="ib-count">{n > 99 ? '99+' : n}</span> : null}
              </Link>
            );
          })}
        </nav>

        <details className="ib-filters" open={advanced > 0}>
          <summary><Ico name="filter" size={15} /> Filtros{advanced > 0 ? <span className="ib-count">{advanced}</span> : null}</summary>
          <Form action="/inbox" className="ib-filter-form">
            {query.tab !== 'all' ? <input type="hidden" name="f" value={query.tab} /> : null}
            {query.q ? <input type="hidden" name="q" value={query.q} /> : null}
            <label>Canal
              <select name="canal" defaultValue={query.canal} className="ib-select">
                <option value="">Todos</option>
                {CHANNELS.map((k) => <option key={k} value={k} disabled={!connected.has(k)}>{CHANNEL_LABEL[k]}{connected.has(k) ? '' : ' (sin conectar)'}</option>)}
              </select>
            </label>
            <label>Asesor
              <select name="asesor" defaultValue={query.asesor} className="ib-select">
                <option value="">Todos</option><option value="none">Sin asignar</option>
                {advisors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <label>Etiqueta
              <select name="etiqueta" defaultValue={query.etiqueta} className="ib-select">
                <option value="">Todas</option>
                {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label>Fecha
              <select name="fecha" defaultValue={query.fecha} className="ib-select">
                <option value="">Cualquiera</option><option value="hoy">Hoy</option><option value="7d">Últimos 7 días</option><option value="30d">Últimos 30 días</option>
              </select>
            </label>
            <label>Estado
              <select name="estado" defaultValue={query.estado} className="ib-select">
                <option value="">Cualquiera</option><option value="open">Abierta</option><option value="closed">Cerrada</option>
              </select>
            </label>
            <div className="ib-filter-actions">
              <button type="submit" className="ib-btn ib-btn--primary ib-btn--sm">Aplicar</button>
              {advanced > 0 || query.q ? <Link className="ib-btn ib-btn--ghost ib-btn--sm" href={inboxHref({ ...query, canal: '', asesor: '', etiqueta: '', fecha: '', estado: '', q: '' }, { c: query.c })} scroll={false}>Limpiar</Link> : null}
            </div>
          </Form>
        </details>
      </header>

      <div className="ib-rows">
        {!hasChannels ? (
          <div className="ib-empty">
            <p><strong>Aún no hay un canal de WhatsApp conectado.</strong></p>
            {canManageChannels ? <Link className="ib-btn ib-btn--primary" href="/settings/connections">Conectar WhatsApp</Link> : <p className="ib-muted">Pide a un administrador que lo conecte en Configuración → Conexiones.</p>}
          </div>
        ) : rows.length === 0 ? (
          <div className="ib-empty">
            <p><strong>{query.q || advanced > 0 || query.tab !== 'all' ? 'No hay conversaciones con estos filtros.' : 'Todavía no hay conversaciones.'}</strong></p>
            {query.q || advanced > 0 || query.tab !== 'all' ? <Link className="ib-btn ib-btn--ghost ib-btn--sm" href="/inbox" scroll={false}>Ver todas</Link> : <p className="ib-muted">Cuando un cliente escriba por WhatsApp aparecerá aquí.</p>}
          </div>
        ) : rows.map(({ conv, name, ownerName, tags: rowTags, channel }) => (
          <Link key={conv.id} href={inboxHref(query, { c: conv.id })} scroll={false} className={`ib-row${conv.id === query.c ? ' is-selected' : ''}${conv.unread ? ' is-unread' : ''}`} aria-current={conv.id === query.c ? 'true' : undefined}>
            <InboxAvatar name={name} channel={channel} size={42} />
            <span className="ib-row-main">
              <span className="ib-row-top">
                <span className="ib-row-name">{name}</span>
                <span className="ib-row-time">{listTime(conv.lastMessageAt, timeZone, now)}</span>
              </span>
              <span className="ib-row-preview">{conv.lastDirection === 'outbound' ? <span className="ib-you">Tú: </span> : null}{conv.lastMessagePreview ?? ''}</span>
              <span className="ib-row-meta">
                {rowTags.slice(0, 2).map((t) => <TagPill key={t.id} tag={t} />)}
                {rowTags.length > 2 ? <span className="ib-more">+{rowTags.length - 2}</span> : null}
                {conv.status === 'closed' ? <span className="ib-state">Cerrada</span> : conv.needsReply ? <span className="ib-state ib-state--warn">Sin responder</span> : null}
                <span className="ib-owner" title="Asesor asignado">{ownerName ?? 'Sin asignar'}</span>
              </span>
            </span>
            {conv.unreadCount > 0 ? <span className="ib-unread" aria-label={`${conv.unreadCount} sin leer`}>{conv.unreadCount > 99 ? '99+' : conv.unreadCount}</span> : null}
          </Link>
        ))}
        {nextHref ? <Link className="ib-more-link" href={nextHref} scroll={false}>Ver más conversaciones</Link> : null}
      </div>
    </aside>
  );
}
