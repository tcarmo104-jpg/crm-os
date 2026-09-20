import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { kanbanHref, kpis, parseKanbanQuery } from '@/lib/kanban';
import { orderedStages } from '@/lib/pipeline';
import { formatMoney } from '@/lib/money';
import { listMembers } from '@/repositories/members';
import { listPipelines } from '@/repositories/pipelines';
import { listProducts } from '@/repositories/products';
import { listTeams } from '@/repositories/teams';
import { listCities, loadBoard, loadOpportunityDetail, CLOSED_WINDOW_DAYS, OPEN_LIMIT } from '@/repositories/opportunities-board';
import { Notice } from '@/components/ui';
import { DetailPanel } from '@/components/kanban/DetailPanel';
import { Drawer } from '@/components/kanban/Drawer';
import { FilterBar } from '@/components/kanban/FilterBar';
import { KanbanBoard } from '@/components/kanban/KanbanBoard';
import { ListView } from '@/components/kanban/ListView';
import { moveCardAction } from './kanban-actions';
import './kanban.css';

export const metadata: Metadata = { title: 'Oportunidades' };

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = parseKanbanQuery(await searchParams);
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();

  if (!can(session, 'opportunities:read')) {
    return <div className="kb-noaccess"><Notice kind="error">Tu rol no tiene acceso a Oportunidades.</Notice></div>;
  }

  const [pipelines, members, teams, products, cities, flash] = await Promise.all([
    listPipelines(db, org.orgId), listMembers(db, org.orgId), listTeams(db, org.orgId),
    listProducts(db, { orgId: org.orgId, activeOnly: true }).catch(() => []), listCities(db, org.orgId).catch(() => []), readFlash(),
  ]);
  const pipeline = pipelines.find((p) => p.id === query.pipeline) ?? pipelines.find((p) => p.isDefault) ?? pipelines[0];
  const canUpdate = can(session, 'opportunities:update');
  const canReopenClosed = session.permissions['opportunities:update'] === 'org';

  const memberName = (id: string | null | undefined) => {
    const m = members.find((x) => x.userId === id);
    return id ? (m?.fullName ?? m?.email ?? 'Alguien') : 'Sin asignar';
  };
  const advisors = members.map((m) => ({ value: m.userId, label: m.fullName ?? m.email ?? 'Sin nombre' }));

  if (!pipeline) {
    return (
      <div className="kb"><header className="kb-head"><h1>Oportunidades</h1></header>
        <p className="kb-empty-list">Todavía no hay un pipeline. Se crea en Configuración → Pipelines.</p></div>
    );
  }

  const stages = orderedStages(pipeline.stages);
  const board = await loadBoard(db, { orgId: org.orgId, pipeline, query, members });
  const k = kpis(board.cards);
  const currency = board.cards.find((c) => c.currency)?.currency ?? 'COP';
  const money = (n: number) => formatMoney(n, currency, org.orgLocale);
  const hrefBase = kanbanHref(query, { o: '' });
  const onlyStageHrefs = Object.fromEntries(stages.map((s) => [s.id, kanbanHref(query, { etapa: s.id, o: '' })]));
  const detail = query.o ? await loadOpportunityDetail(db, org.orgId, query.o) : null;

  return (
    <div className="kb">
      <header className="kb-head">
        <div>
          <h1>Oportunidades</h1>
          <p className="kb-muted">{pipeline.name}{pipelines.length > 1 ? ' · pipeline' : ''}</p>
        </div>
        {can(session, 'opportunities:create') ? <Link href="/opportunities/new" className="kb-btn kb-btn--primary">+ Nueva oportunidad</Link> : null}
      </header>

      <section className="kb-kpis" aria-label="Resumen del pipeline">
        <div className="kb-kpi kb-kpi--main"><span>Valor total del pipeline</span><strong>{money(k.pipelineTotal)}</strong></div>
        <div className="kb-kpi"><span>Oportunidades abiertas</span><strong>{k.open}</strong></div>
        <div className="kb-kpi"><span>Ganadas · {CLOSED_WINDOW_DAYS} días</span><strong>{k.won}</strong><small>{money(k.wonAmount)}</small></div>
        <div className="kb-kpi"><span>Perdidas · {CLOSED_WINDOW_DAYS} días</span><strong>{k.lost}</strong><small>{money(k.lostAmount)}</small></div>
      </section>

      <FilterBar query={query} hrefBase={hrefBase} pipelines={pipelines} pipelineId={pipeline.id} stages={stages} advisors={advisors}
        teams={teams.map((t) => ({ value: t.id, label: t.name }))} products={products.map((p) => ({ value: p.id, label: p.name }))} cities={cities} />

      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}
      {board.openTruncated ? <Notice kind="error">Hay más de {OPEN_LIMIT} oportunidades abiertas con estos filtros: solo se muestran las {OPEN_LIMIT} más recientes. Usa los filtros para acotar.</Notice> : null}

      {query.vista === 'lista'
        ? <ListView cards={board.cards} stages={stages} query={query} locale={org.orgLocale} timeZone={org.orgTimezone} />
        : (
          <KanbanBoard stages={stages} cards={board.cards} canMove={canUpdate} canReopenClosed={canReopenClosed} hrefBase={hrefBase} selectedId={query.o}
            locale={org.orgLocale} timeZone={org.orgTimezone} currency={currency} moveAction={moveCardAction} onlyStageHrefs={onlyStageHrefs} />
        )}
      <p className="kb-foot kb-muted">Las columnas Ganada y Perdida muestran los últimos {CLOSED_WINDOW_DAYS} días. Arrastra una tarjeta para cambiar de etapa; en el celular, mantén pulsada la tarjeta o usa «Cambiar de etapa» en el detalle.</p>

      {query.o ? (
        <Drawer closeHref={hrefBase} title="Detalle de la oportunidad">
          {detail
            ? <DetailPanel d={detail} stages={stages} nameOf={memberName} locale={org.orgLocale} timeZone={org.orgTimezone} canUpdate={canUpdate} canReadInbox={can(session, 'conversations:read')} />
            : <div className="kb-detail"><h2>No encontramos esta oportunidad</h2><p className="kb-muted">Puede que el enlace esté incompleto o que sea de un cliente que no tienes asignado.</p></div>}
        </Drawer>
      ) : null}
    </div>
  );
}
