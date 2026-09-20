'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, TouchSensor, pointerWithin, rectIntersection, useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SORTS, applyMove, buildColumns, dropOutcome, type BoardCard, type SortKey } from '@/lib/kanban';
import { formatMoney } from '@/lib/money';
import type { StageRow } from '@/lib/types';
import { OppCard } from './OppCard';
import { MoveDialog, type DialogState } from './MoveDialog';

export type MoveResult = { ok: true } | { ok: false; error: string };
type Toast = { kind: 'ok' | 'error'; message: string } | null;

function DraggableCard({ card, href, locale, timeZone, canMove, selected }: { card: BoardCard; href: string; locale: string; timeZone: string; canMove: boolean; selected: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.id, disabled: !canMove });
  // El nodo arrastrable NO debe declararse «botón»: dentro hay un enlace y eso confundiría a los lectores de pantalla.
  const { role: _role, tabIndex: _tab, ...aria } = attributes;
  void _role; void _tab;
  return (
    <div ref={setNodeRef} className={`kb-drag${isDragging ? ' is-dragging' : ''}`} {...aria} {...listeners}>
      <OppCard card={card} href={href} locale={locale} timeZone={timeZone} selected={selected} />
    </div>
  );
}

/** Zona fija que aparece SOLO mientras se arrastra: evita tener que llevar la tarjeta hasta una columna que quedó fuera de pantalla. */
function DropZone({ stage }: { stage: StageRow }) {
  const { setNodeRef, isOver } = useDroppable({ id: `zone:${stage.id}` });
  return (
    <div ref={setNodeRef} className={`kb-zone kb-zone--${stage.kind}${isOver ? ' is-over' : ''}`}>
      <strong>{stage.name}</strong><span>Suelta aquí</span>
    </div>
  );
}

const collision: CollisionDetection = (args) => { const hit = pointerWithin(args); return hit.length ? hit : rectIntersection(args); };

function Column({ col, children, sort, onSort, currency, locale, onlyHref }: {
  col: ReturnType<typeof buildColumns>[number]; children: React.ReactNode; sort: SortKey; onSort: (s: SortKey) => void; currency: string; locale: string; onlyHref: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `stage:${col.stage.id}` });
  const menu = useRef<HTMLDetailsElement>(null);
  return (
    <section ref={setNodeRef} id={`kb-col-${col.stage.id}`} className={`kb-col kb-col--${col.stage.kind}${isOver ? ' is-over' : ''}`} aria-label={`${col.stage.name}: ${col.count} oportunidades`}>
      <header className="kb-col-head">
        <div className="kb-col-titles">
          <h2 className="kb-col-name">{col.stage.name}</h2>
          <p className="kb-col-sum"><span>{col.count} {col.count === 1 ? 'oportunidad' : 'oportunidades'}</span><strong>{formatMoney(col.amount, currency, locale)}</strong></p>
        </div>
        <details ref={menu} className="kb-menu">
          <summary aria-label={`Acciones de la columna ${col.stage.name}`}>⋯</summary>
          <div className="kb-menu-pop" role="menu">
            <p className="kb-menu-title">Ordenar por</p>
            {SORTS.map((s) => (
              <button key={s.key} type="button" role="menuitemradio" aria-checked={sort === s.key} className={sort === s.key ? 'is-on' : ''} onClick={() => { onSort(s.key); if (menu.current) menu.current.open = false; }}>{s.label}</button>
            ))}
            <a role="menuitem" href={onlyHref} className="kb-menu-link">Ver solo esta etapa</a>
          </div>
        </details>
      </header>
      <div className="kb-col-body">
        {children}
        {col.count === 0 ? <p className="kb-col-empty">Sin oportunidades</p> : null}
      </div>
    </section>
  );
}

export function KanbanBoard({
  stages, cards: initial, canMove, canReopenClosed, hrefBase, selectedId, locale, timeZone, currency, moveAction, onlyStageHrefs,
}: {
  stages: StageRow[]; cards: BoardCard[]; canMove: boolean; canReopenClosed: boolean; hrefBase: string; selectedId: string; locale: string; timeZone: string; currency: string;
  moveAction: (input: { id: string; stageId: string; reason?: string }) => Promise<MoveResult>; onlyStageHrefs: Record<string, string>;
}) {
  const [cards, setCards] = useState(initial);
  const [sorts, setSorts] = useState<Record<string, SortKey>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<(DialogState & { toId: string }) | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const pending = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cuando el servidor manda datos frescos se sincroniza, salvo que haya un movimiento en camino.
  useEffect(() => { if (pending.current === 0) setCards(initial); }, [initial]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
  const columns = useMemo(() => buildColumns(stages, cards, sorts), [stages, cards, sorts]);
  const byId = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages]);
  const href = useCallback((id: string) => `${hrefBase}${hrefBase.includes('?') ? '&' : '?'}o=${id}`, [hrefBase]);

  const notify = useCallback((kind: 'ok' | 'error', message: string) => {
    setToast({ kind, message });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), kind === 'error' ? 7000 : 3500);
  }, []);

  const doMove = useCallback(async (card: BoardCard, to: StageRow, reason?: string) => {
    const from = byId.get(card.stageId);
    const prev = { stageId: card.stageId, status: card.status };
    setCards((c) => applyMove(c, card.id, to));                     // 1) la pantalla cambia al instante
    pending.current++;
    const r = await moveAction({ id: card.id, stageId: to.id, reason }).catch((): MoveResult => ({ ok: false, error: 'No se pudo guardar el cambio. Revisa tu conexión e inténtalo de nuevo.' }));
    pending.current--;
    if (!r.ok) {                                                   // 2) si el servidor lo rechaza, vuelve a su sitio y se explica por qué
      setCards((c) => c.map((x) => (x.id === card.id ? { ...x, ...prev } : x)));
      notify('error', r.error);
    } else {
      notify('ok', `${card.customerName}: ${from?.name ?? '—'} → ${to.name}`);
    }
  }, [byId, moveAction, notify]);

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const card = cards.find((c) => c.id === e.active.id);
    const overId = e.over ? String(e.over.id) : '';
    if (!card || !(overId.startsWith('stage:') || overId.startsWith('zone:'))) return;
    const to = byId.get(overId.slice(overId.indexOf(':') + 1));
    const from = byId.get(card.stageId);
    if (!to || !from) return;
    const out = dropOutcome({ from, to, canReopenClosed });
    if (out.type === 'noop') return;
    if (out.type === 'blocked') return notify('error', out.message);
    if (out.type === 'move') return void doMove(card, to);
    setDialog({ kind: out.type === 'reason' ? 'reason' : 'won', cardId: card.id, customer: card.customerName, title: card.title, stageName: to.name, toId: to.id });
  };

  const active = activeId ? cards.find((c) => c.id === activeId) : null;
  const wonStage = stages.find((x) => x.kind === 'won');
  const lostStage = stages.find((x) => x.kind === 'lost');
  const confirm = (reason?: string) => {
    const d = dialog; setDialog(null);
    if (!d) return;
    const card = cards.find((c) => c.id === d.cardId); const to = byId.get(d.toId);
    if (card && to) void doMove(card, to, reason);
  };

  return (
    <>
      <nav className="kb-stage-nav" aria-label="Ir a una etapa">
        {columns.map((c) => (
          <button key={c.stage.id} type="button" onClick={() => document.getElementById(`kb-col-${c.stage.id}`)?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })}>
            {c.stage.name}<span>{c.count}</span>
          </button>
        ))}
      </nav>
      <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
        <div className="kb-board" role="group" aria-label="Tablero de oportunidades por etapa">
          {columns.map((col) => (
            <Column key={col.stage.id} col={col} sort={sorts[col.stage.id] ?? 'recientes'} onSort={(s) => setSorts((p) => ({ ...p, [col.stage.id]: s }))}
              currency={currency} locale={locale} onlyHref={onlyStageHrefs[col.stage.id] ?? '/opportunities'}>
              {col.cards.map((card) => (
                <DraggableCard key={card.id} card={card} href={href(card.id)} locale={locale} timeZone={timeZone} canMove={canMove} selected={card.id === selectedId} />
              ))}
            </Column>
          ))}
        </div>
        {active && wonStage && lostStage ? (
          <div className="kb-zones" role="group" aria-label="Cerrar la oportunidad"><DropZone stage={wonStage} /><DropZone stage={lostStage} /></div>
        ) : null}
        <DragOverlay dropAnimation={null}>
          {active ? <OppCard card={active} href="#" locale={locale} timeZone={timeZone} overlay /> : null}
        </DragOverlay>
      </DndContext>
      <MoveDialog state={dialog} onCancel={() => setDialog(null)} onConfirm={confirm} />
      <div className="kb-toast-wrap" aria-live="polite" role="status">
        {toast ? <p className={`kb-toast kb-toast--${toast.kind}`}>{toast.message}</p> : null}
      </div>
    </>
  );
}
