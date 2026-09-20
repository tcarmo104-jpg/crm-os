import Link from 'next/link';
import { PRIORITY_LABEL, TEMPERATURE_LABEL, isOverdue, kanbanHref, type BoardCard, type KanbanQuery } from '@/lib/kanban';
import { formatMoney } from '@/lib/money';
import type { StageRow } from '@/lib/types';
import { ChannelChip, PriorityMark } from './OppCard';

export function ListView({ cards, stages, query, locale, timeZone }: { cards: BoardCard[]; stages: StageRow[]; query: KanbanQuery; locale: string; timeZone: string }) {
  const stage = new Map(stages.map((s) => [s.id, s]));
  const date = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric', timeZone });
  const rows = [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (rows.length === 0) return <p className="kb-empty-list">No hay oportunidades con estos filtros.</p>;
  return (
    <div className="kb-table-wrap">
      <table className="kb-table">
        <thead><tr><th>Nº</th><th>Cliente</th><th>Oportunidad</th><th>Etapa</th><th className="num">Valor</th><th>Prioridad</th><th>Temperatura</th><th>Canal</th><th>Asesor</th><th>Cierre</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className={c.id === query.o ? 'is-selected' : ''}>
              <td className="kb-muted">{c.number}</td>
              <td><Link href={kanbanHref(query, { o: c.id })} scroll={false} className="kb-row-link">{c.customerName}</Link></td>
              <td>{c.title}</td>
              <td><span className={`kb-stage-pill kb-stage-pill--${stage.get(c.stageId)?.kind ?? 'open'}`}>{stage.get(c.stageId)?.name ?? '—'}</span></td>
              <td className="num">{formatMoney(c.amount, c.currency, locale)}</td>
              <td><span className="kb-prio-cell"><PriorityMark priority={c.priority} />{PRIORITY_LABEL[c.priority]}</span></td>
              <td>{c.temperature ? TEMPERATURE_LABEL[c.temperature] : <span className="kb-muted">—</span>}</td>
              <td>{c.channel ? <ChannelChip channel={c.channel} /> : <span className="kb-muted">—</span>}</td>
              <td>{c.ownerName ?? <span className="kb-muted">Sin asignar</span>}</td>
              <td className={isOverdue(c) ? 'kb-overdue' : ''}>{c.expectedCloseDate ? date.format(new Date(`${c.expectedCloseDate}T12:00:00`)) : <span className="kb-muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
