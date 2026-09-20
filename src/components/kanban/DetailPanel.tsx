import Link from 'next/link';
import { QUOTE_STATUS } from '@/lib/commerce-labels';
import { OPP_CHANNELS, OPP_CHANNEL_LABEL, PRIORITIES, PRIORITY_LABEL, TEMPERATURES, TEMPERATURE_LABEL } from '@/lib/kanban';
import { buildHistory } from '@/lib/kanban-history';
import { extOf, formatBytes } from '@/lib/media';
import { formatMoney } from '@/lib/money';
import type { OpportunityDetail } from '@/repositories/opportunities-board';
import type { StageRow } from '@/lib/types';
import { changeStageAction, logActivityAction, setFieldsAction } from '@/app/(app)/opportunities/kanban-actions';
import { AutoSelect } from './AutoSelect';

const ACTIVITY_TYPES = [
  { value: 'note', label: 'Nota' }, { value: 'call', label: 'Llamada' }, { value: 'whatsapp', label: 'Mensaje de WhatsApp' },
  { value: 'email', label: 'Correo' }, { value: 'meeting', label: 'Reunión' },
];

export function DetailPanel({
  d, stages, nameOf, locale, timeZone, canUpdate, canReadInbox,
}: {
  d: OpportunityDetail; stages: StageRow[]; nameOf: (id: string | null | undefined) => string; locale: string; timeZone: string; canUpdate: boolean; canReadInbox: boolean;
}) {
  const { opp, customer } = d;
  const stage = stages.find((s) => s.id === opp.stageId);
  const day = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeZone });
  const stamp = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone });
  const money = (n: number) => formatMoney(n, opp.currency, locale);
  const history = buildHistory(d.transitions, d.activities, nameOf);
  const phones = d.identifiers.filter((i) => i.type === 'phone');
  const emails = d.identifiers.filter((i) => i.type === 'email');
  const fields = { id: opp.id };

  return (
    <div className="kb-detail">
      <header className="kb-detail-head">
        <p className="kb-detail-num">{opp.number}{stage ? <span className={`kb-stage-pill kb-stage-pill--${stage.kind}`}>{stage.name}</span> : null}</p>
        <h2>{opp.title}</h2>
        <p className="kb-muted"><Link href={`/customers/${customer.id}`}>{customer.fullName}</Link> · <strong>{money(opp.amount)}</strong></p>
        <div className="kb-detail-actions">
          {opp.conversationId && canReadInbox ? <Link className="kb-btn kb-btn--primary kb-btn--sm" href={`/inbox?c=${opp.conversationId}`}>Ver conversación</Link> : null}
          <Link className="kb-btn kb-btn--ghost kb-btn--sm" href={`/opportunities/${opp.id}`}>Abrir ficha completa</Link>
        </div>
      </header>

      {canUpdate ? (
        <form action={changeStageAction} className="kb-stage-form">
          <input type="hidden" name="id" value={opp.id} />
          <label className="kb-label" htmlFor="kb-stage">Cambiar de etapa</label>
          <div className="kb-stage-row">
            <select id="kb-stage" name="stageId" className="kb-select" defaultValue={opp.stageId}>
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input name="reason" className="kb-input" maxLength={500} placeholder="Motivo (solo si la pierdes)" aria-label="Motivo si se pierde" />
            <button type="submit" className="kb-btn kb-btn--secondary kb-btn--sm">Mover</button>
          </div>
        </form>
      ) : null}

      <section aria-labelledby="kb-s-datos">
        <h3 id="kb-s-datos">Datos de la oportunidad</h3>
        <dl className="kb-kv">
          <dt>Nombre</dt><dd>{opp.title}</dd>
          <dt>Cliente</dt><dd><Link href={`/customers/${customer.id}`}>{customer.fullName}</Link></dd>
          <dt>Valor</dt><dd>{money(opp.amount)}</dd>
          <dt>Etapa</dt><dd>{stage?.name ?? '—'}</dd>
          <dt>Prioridad</dt>
          <dd>{canUpdate ? <AutoSelect action={setFieldsAction} name="priority" label="Prioridad" value={opp.priority} fields={fields} options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))} /> : PRIORITY_LABEL[opp.priority]}</dd>
          <dt>Temperatura</dt>
          <dd>{canUpdate ? <AutoSelect action={setFieldsAction} name="temperature" label="Temperatura" value={opp.temperature ?? ''} fields={fields} options={[{ value: '', label: 'Sin definir' }, ...TEMPERATURES.map((t) => ({ value: t, label: TEMPERATURE_LABEL[t] }))]} /> : (opp.temperature ? TEMPERATURE_LABEL[opp.temperature] : 'Sin definir')}</dd>
          <dt>Asesor</dt><dd>{customer.ownerId ? nameOf(customer.ownerId) : 'Sin asignar'}</dd>
          <dt>Canal</dt>
          <dd>{canUpdate ? <AutoSelect action={setFieldsAction} name="channel" label="Canal" value={opp.channel ?? ''} fields={fields} options={[{ value: '', label: 'Sin definir' }, ...OPP_CHANNELS.map((c) => ({ value: c, label: OPP_CHANNEL_LABEL[c] }))]} /> : (opp.channel ? OPP_CHANNEL_LABEL[opp.channel as keyof typeof OPP_CHANNEL_LABEL] ?? opp.channel : 'Sin definir')}</dd>
          <dt>Creada</dt><dd>{stamp.format(new Date(opp.createdAt))}</dd>
          <dt>Cierre estimado</dt><dd>{opp.expectedCloseDate ? day.format(new Date(`${opp.expectedCloseDate}T12:00:00`)) : 'Sin fecha'}</dd>
          {opp.status === 'lost' && opp.lostReason ? <><dt>Motivo</dt><dd>{opp.lostReason}</dd></> : null}
        </dl>
      </section>

      <section aria-labelledby="kb-s-cliente">
        <h3 id="kb-s-cliente">Cliente</h3>
        <dl className="kb-kv">
          <dt>Nombre</dt><dd><Link href={`/customers/${customer.id}`}>{customer.fullName}</Link></dd>
          <dt>Teléfono</dt><dd>{phones.length ? phones.map((p) => <span key={p.id} className="kb-block">{p.value}</span>) : '—'}</dd>
          <dt>Correo</dt><dd>{emails.length ? emails.map((p) => <span key={p.id} className="kb-block">{p.value}</span>) : '—'}</dd>
          <dt>Empresa</dt><dd>{d.company ? <Link href={`/customers/${d.company.id}`}>{d.company.fullName}</Link> : '—'}</dd>
        </dl>
      </section>

      <section aria-labelledby="kb-s-prod">
        <h3 id="kb-s-prod">Productos</h3>
        {d.products.length > 0 ? (
          <>
            <ul className="kb-lines">
              {d.products.map((p, i) => <li key={i}><span>{p.description}</span><span className="kb-muted">× {p.quantity}</span><strong>{money(p.total)}</strong></li>)}
            </ul>
            <p className="kb-hint">Según la cotización {d.productsFrom}.</p>
          </>
        ) : opp.productInterest ? <p>{opp.productInterest} <span className="kb-hint">(producto de interés; aún sin cotización)</span></p> : <p className="kb-muted">Sin productos asociados todavía.</p>}
      </section>

      <section aria-labelledby="kb-s-cot">
        <h3 id="kb-s-cot">Cotizaciones</h3>
        {d.quotes.length === 0 ? <p className="kb-muted">Aún no hay cotizaciones. Se crean desde la ficha completa.</p> : (
          <ul className="kb-lines">
            {d.quotes.map((q) => {
              const [label] = QUOTE_STATUS[q.status] ?? [q.status];
              return <li key={q.id}><Link href={`/quotes/${q.id}`}>{q.number} · v{q.version}</Link><span className={`kb-pill kb-pill--${q.status}`}>{label}</span><strong>{formatMoney(q.total, q.currency, locale)}</strong></li>;
            })}
          </ul>
        )}
      </section>

      {d.files.length > 0 ? (
        <section aria-labelledby="kb-s-files">
          <h3 id="kb-s-files">Archivos de la conversación ({d.files.length})</h3>
          <ul className="kb-lines">
            {d.files.map((f) => (
              <li key={f.id}>
                <a href={`/api/media/${f.id}`} target="_blank" rel="noopener noreferrer">{f.fileName ?? 'Archivo'}</a>
                <span className="kb-hint">{[extOf(f.fileName).toUpperCase(), formatBytes(f.fileSize)].filter(Boolean).join(' · ')}</span>
                <a href={`/api/media/${f.id}?download=1`}>Descargar</a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="kb-s-act">
        <h3 id="kb-s-act">Actividades</h3>
        {canUpdate ? (
          <form action={logActivityAction} className="kb-act-form">
            <input type="hidden" name="id" value={opp.id} /><input type="hidden" name="customerId" value={customer.id} />
            <label className="sr-only" htmlFor="kb-act-type">Tipo de actividad</label>
            <select id="kb-act-type" name="type" className="kb-select" defaultValue="note">{ACTIVITY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
            <label className="sr-only" htmlFor="kb-act-text">Qué pasó</label>
            <textarea id="kb-act-text" name="summary" className="kb-input" rows={2} maxLength={2000} required placeholder="¿Qué pasó? (llamada, mensaje, reunión, nota…)" />
            <button type="submit" className="kb-btn kb-btn--secondary kb-btn--sm">Registrar</button>
          </form>
        ) : null}
        {d.activities.length === 0 ? <p className="kb-muted">Sin actividades registradas.</p> : (
          <ul className="kb-timeline">
            {d.activities.slice(0, 8).map((a) => <li key={a.id}><p>{a.summary}</p><small>{ACTIVITY_TYPES.find((t) => t.value === a.type)?.label ?? a.type} · {nameOf(a.createdBy)} · {stamp.format(new Date(a.occurredAt))}</small></li>)}
          </ul>
        )}
      </section>

      <section aria-labelledby="kb-s-hist">
        <h3 id="kb-s-hist">Historial</h3>
        {history.length === 0 ? <p className="kb-muted">Sin movimientos todavía.</p> : (
          <ol className="kb-timeline kb-timeline--hist">
            {history.map((h) => <li key={h.id} className={`is-${h.kind}`}><p>{h.text}</p>{h.detail ? <p className="kb-muted">{h.detail}</p> : null}<small>{stamp.format(new Date(h.at))}</small></li>)}
          </ol>
        )}
      </section>

    </div>
  );
}
