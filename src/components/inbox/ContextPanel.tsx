import Link from 'next/link';
import { formatMoney } from '@/lib/money';
import { SALE_STATUS } from '@/lib/commerce-labels';
import type { CustomerContext } from '@/repositories/inbox-context';
import type { TagRow } from '@/lib/types';
import { InboxAvatar } from './Avatar';
import { ContextToggle } from './ContextToggle';
import { Ico } from './icons';
import { TagPill } from './TagPill';

type Action = (fd: FormData) => Promise<void>;
const STAGE: Record<string, string> = { lead: 'Prospecto', prospect: 'Prospecto', customer: 'Cliente', active: 'Activo', inactive: 'Inactivo', lost: 'Perdido' };
const CHANNEL_PREF: Record<string, string> = { whatsapp: 'WhatsApp', phone: 'Llamada', email: 'Correo', sms: 'SMS' };

function Section({ title, count, open = true, children, action }: { title: string; count?: number; open?: boolean; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <details className="ib-sec" open={open}>
      <summary>
        <span className="ib-sec-title">{title}</span>
        {typeof count === 'number' ? <span className="ib-count ib-count--muted">{count}</span> : null}
        <span className="ib-sec-chev"><Ico name="chevronDown" size={14} /></span>
      </summary>
      <div className="ib-sec-body">{children}{action}</div>
    </details>
  );
}

export function ContextPanel({
  ctx, allTags, ownerName, timeZone, conversationId, canEditCustomer, actions, nameOf,
}: {
  ctx: CustomerContext; allTags: TagRow[]; ownerName: string | null; timeZone: string; conversationId: string; canEditCustomer: boolean;
  actions: { addTag: Action; removeTag: Action }; nameOf: (id: string | null) => string;
}) {
  const c = ctx.customer;
  const date = new Intl.DateTimeFormat('es', { timeZone, day: 'numeric', month: 'short', year: 'numeric' });
  const short = new Intl.DateTimeFormat('es', { timeZone, day: 'numeric', month: 'short' });
  const phones = ctx.identifiers.filter((i) => i.type === 'phone');
  const emails = ctx.identifiers.filter((i) => i.type === 'email');
  const other = ctx.identifiers.filter((i) => i.type !== 'phone' && i.type !== 'email');
  const free = allTags.filter((t) => !ctx.tags.some((x) => x.id === t.id));
  const currency = ctx.sales.items.find((s) => s.currency)?.currency ?? null;
  const fields = ctx.fieldDefs.filter((d) => !d.archivedAt).map((d) => ({ d, v: c.customFields?.[d.key] })).filter((x) => x.v !== undefined && x.v !== null && x.v !== '');

  return (
    <aside className="ib-context" aria-label="Ficha del cliente">
      <div className="ib-context-close"><ContextToggle variant="close" /></div>
      <header className="ib-ctx-head">
        <InboxAvatar name={c.fullName} size={64} />
        <h2><Link href={`/customers/${c.id}`}>{c.fullName}</Link></h2>
        {ctx.tags[0] ? <TagPill tag={ctx.tags[0]} /> : null}
        {c.doNotContact ? <span className="ib-state ib-state--danger">No contactar</span> : null}
      </header>

      <Section title="Datos del contacto">
        <ul className="ib-facts">
          {phones.map((i) => <li key={i.id}><Ico name="phone" size={15} /><span>{i.value}</span></li>)}
          {emails.map((i) => <li key={i.id}><Ico name="mail" size={15} /><span>{i.value}</span></li>)}
          {other.map((i) => <li key={i.id}><Ico name="user" size={15} /><span>{i.type}: {i.value}</span></li>)}
          {c.city || c.country ? <li><Ico name="pin" size={15} /><span>{[c.city, c.country].filter(Boolean).join(', ')}</span></li> : null}
          {ctx.company ? <li><Ico name="building" size={15} /><span><Link href={`/customers/${ctx.company.id}`}>{ctx.company.fullName}</Link></span></li> : null}
          <li><Ico name="user" size={15} /><span>Asesor: {ownerName ?? 'Sin asignar'}</span></li>
        </ul>
      </Section>

      <Section title="Etiquetas" count={ctx.tags.length}>
        <div className="ib-tags">
          {ctx.tags.length === 0 ? <span className="ib-muted">Sin etiquetas.</span> : ctx.tags.map((t) => (
            <TagPill key={t.id} tag={t}>
              {canEditCustomer ? (
                <form action={actions.removeTag} className="ib-tag-x">
                  <input type="hidden" name="customerId" value={c.id} /><input type="hidden" name="tagId" value={t.id} /><input type="hidden" name="conversationId" value={conversationId} /><button type="submit" aria-label={`Quitar la etiqueta ${t.name}`} title="Quitar"><Ico name="x" size={11} /></button>
                </form>
              ) : null}
            </TagPill>
          ))}
        </div>
        {canEditCustomer ? (
          <form action={actions.addTag} className="ib-tag-add">
            <input type="hidden" name="customerId" value={c.id} /><input type="hidden" name="conversationId" value={conversationId} /><label className="sr-only" htmlFor="ib-tag-name">Nueva etiqueta</label>
            <input id="ib-tag-name" name="name" list="ib-tag-options" maxLength={40} required placeholder="+ Añadir etiqueta" className="ib-input" autoComplete="off" />
            <datalist id="ib-tag-options">{free.map((t) => <option key={t.id} value={t.name} />)}</datalist>
            <button type="submit" className="ib-btn ib-btn--ghost ib-btn--sm">Añadir</button>
          </form>
        ) : null}
      </Section>

      <Section title="Pedidos" count={ctx.sales.count}>
        {ctx.sales.items.length === 0 ? <p className="ib-muted">Este cliente aún no tiene pedidos.</p> : (
          <ul className="ib-orders">
            {ctx.sales.items.map((s) => {
              const [label, cls] = SALE_STATUS[s.status] ?? [s.status, ''];
              return (
                <li key={s.id}>
                  <Link href={`/sales/${s.id}`} className="ib-order-no">{s.number}</Link>
                  <span className={`ib-pill ib-pill--${s.status}`} data-badge={cls}>{label}</span>
                  <span className="ib-order-total">{formatMoney(s.total, s.currency)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Notas" count={ctx.noteCount} open={false}>
        {ctx.notes.length === 0 ? <p className="ib-muted">Sin notas. Usa la pestaña «Nota interna» del chat.</p> : (
          <ul className="ib-mini">
            {ctx.notes.slice(0, 5).map((n) => <li key={n.id}><p>{n.summary}</p><small>{nameOf(n.createdBy)} · {short.format(new Date(n.occurredAt))}</small></li>)}
          </ul>
        )}
      </Section>

      <Section title="Tareas" count={ctx.tasks.length} open={false}>
        {ctx.tasks.length === 0 ? <p className="ib-muted">Sin tareas pendientes.</p> : (
          <ul className="ib-mini">
            {ctx.tasks.slice(0, 5).map((t) => <li key={t.id}><p>{t.title}</p><small>{t.dueAt ? `Vence ${short.format(new Date(t.dueAt))}` : 'Sin fecha'}</small></li>)}
          </ul>
        )}
        <Link className="ib-link" href="/tasks">Ver todas las tareas</Link>
      </Section>

      <Section title="Productos" count={ctx.products.length} open={false}>
        {ctx.products.length === 0 ? <p className="ib-muted">Aún no ha comprado productos.</p> : (
          <ul className="ib-mini">{ctx.products.map((p) => <li key={p.name}><p>{p.name}</p><small>{p.quantity} {p.quantity === 1 ? 'unidad' : 'unidades'}</small></li>)}</ul>
        )}
      </Section>

      <Section title="Datos clave" open={false}>
        <dl className="ib-kv">
          <dt>Cliente desde</dt><dd>{date.format(new Date(c.firstContactAt))}</dd>
          <dt>Etapa</dt><dd>{STAGE[c.lifecycleStage] ?? c.lifecycleStage}</dd>
          {c.preferredChannel ? <><dt>Canal preferido</dt><dd>{CHANNEL_PREF[c.preferredChannel] ?? c.preferredChannel}</dd></> : null}
          <dt>Pedidos</dt><dd>{ctx.sales.count}</dd>
          <dt>Comprado</dt><dd>{formatMoney(ctx.sales.total, currency)}</dd>
          {fields.map(({ d, v }) => <><dt key={`k${d.id}`}>{d.label}</dt><dd key={`v${d.id}`}>{Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Sí' : 'No') : String(v)}</dd></>)}
        </dl>
      </Section>
    </aside>
  );
}
