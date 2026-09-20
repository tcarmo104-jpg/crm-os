import Link from 'next/link';
import { Ico } from '@/components/inbox/icons';
import { OPP_CHANNEL_LABEL, PRIORITY_LABEL, TEMPERATURE_LABEL, avatarHue, initials, isOverdue, type BoardCard } from '@/lib/kanban';
import { formatMoney } from '@/lib/money';

/** Indicador discreto de prioridad: 3 barritas (alta = 3, media = 2, baja = 1). */
export function PriorityMark({ priority }: { priority: BoardCard['priority'] }) {
  const n = priority === 'high' ? 3 : priority === 'medium' ? 2 : 1;
  return (
    <span className={`kb-prio kb-prio--${priority}`} role="img" aria-label={`Prioridad ${PRIORITY_LABEL[priority].toLowerCase()}`} title={`Prioridad ${PRIORITY_LABEL[priority].toLowerCase()}`}>
      {[1, 2, 3].map((i) => <i key={i} className={i <= n ? 'on' : ''} />)}
    </span>
  );
}

export function ChannelChip({ channel }: { channel: NonNullable<BoardCard['channel']> }) {
  if (channel === 'whatsapp' || channel === 'instagram' || channel === 'facebook') {
    return <span className="kb-chan"><i className={`kb-dot kb-dot--${channel}`} aria-hidden="true" />{OPP_CHANNEL_LABEL[channel]}</span>;
  }
  const icon = channel === 'email' ? 'mail' : channel === 'phone' ? 'phone' : 'tag';
  return <span className="kb-chan"><Ico name={icon} size={13} />{OPP_CHANNEL_LABEL[channel]}</span>;
}

export function TempChip({ temperature }: { temperature: NonNullable<BoardCard['temperature']> }) {
  return <span className={`kb-temp kb-temp--${temperature}`}>{TEMPERATURE_LABEL[temperature]}</span>;
}

/** Avatar con iniciales (estilo propio del tablero; no depende de ningún otro módulo). */
export function KbAvatar({ name, size = 20 }: { name: string | null; size?: number }) {
  return (
    <span className="kb-avatar" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.44), background: name ? `hsl(${avatarHue(name)} 48% 42%)` : '#9aa3bd' }}>
      {initials(name)}
    </span>
  );
}

/** Tarjeta compacta: quién (cliente) · qué (título/producto) · cuánto · cuándo · quién la gestiona · de dónde viene. */
export function OppCard({ card, href, locale, timeZone, selected, overlay }: {
  card: BoardCard; href: string; locale: string; timeZone: string; selected?: boolean; overlay?: boolean;
}) {
  const date = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', timeZone });
  const closeLabel = card.expectedCloseDate ? date.format(new Date(`${card.expectedCloseDate}T12:00:00`)) : null;
  const overdue = isOverdue(card);
  const first = card.ownerName?.split(' ')[0] ?? null;
  return (
    <article className={`kb-card kb-card--${card.priority}${selected ? ' is-selected' : ''}${overlay ? ' is-overlay' : ''}${card.status !== 'open' ? ` is-${card.status}` : ''}`} aria-label={`${card.customerName}: ${card.title}`}>
      <Link href={href} scroll={false} className="kb-card-link" draggable={false}>
        <span className="kb-card-top">
          <span className="kb-card-customer">{card.customerName}</span>
          <PriorityMark priority={card.priority} />
        </span>
        <span className="kb-card-title">{card.title}</span>
        {card.product ? <span className="kb-card-product"><Ico name="tag" size={12} />{card.product}</span> : null}
        <span className="kb-card-mid">
          <strong className="kb-card-amount">{formatMoney(card.amount, card.currency, locale)}</strong>
          {closeLabel ? <span className={`kb-card-date${overdue ? ' is-overdue' : ''}`} title={overdue ? 'Fecha de cierre vencida' : 'Cierre estimado'}>{closeLabel}</span> : null}
        </span>
        <span className="kb-card-foot">
          <span className="kb-card-tags">
            {card.temperature ? <TempChip temperature={card.temperature} /> : null}
            {card.channel ? <ChannelChip channel={card.channel} /> : null}
          </span>
          <span className="kb-card-owner" title={card.ownerName ?? 'Sin asesor asignado'}>
            <KbAvatar name={card.ownerName} size={20} />
            <span>{first ?? 'Sin asesor'}</span>
          </span>
        </span>
        {card.status === 'lost' && card.lostReason ? <span className="kb-card-lost">Motivo: {card.lostReason}</span> : null}
      </Link>
    </article>
  );
}
