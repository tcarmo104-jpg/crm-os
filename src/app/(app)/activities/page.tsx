import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { ACTIVITY_TYPE_ICON, ACTIVITY_TYPE_LABEL, ACTIVITY_TYPES, DIRECTION_LABEL, groupActivitiesByDay } from '@/lib/activities';
import { listActivities } from '@/repositories/activities';
import { getCustomersByIds, listCustomers } from '@/repositories/customers';
import { getOpportunitiesByIds, listOpportunities } from '@/repositories/opportunities';
import { listMembers } from '@/repositories/members';
import { Notice } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { DateFilter, FilterSelect, SearchInput } from '@/components/filters';
import { NewActivityModal } from '@/components/activities/ActivityModal';
import type { Opt, OppOpt } from '@/components/tasks/TaskModals';

export const metadata: Metadata = { title: 'Actividades' };

type Params = { tipo?: string; responsable?: string; cliente?: string; desde?: string; hasta?: string; q?: string };

export default async function ActivitiesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  if (!can(session, 'customers:read')) return <><header className="page-head"><h1>Actividades</h1></header><Notice kind="error">No tienes acceso a este módulo.</Notice></>;

  const type = ACTIVITY_TYPES.includes((sp.tipo ?? '') as (typeof ACTIVITY_TYPES)[number]) ? sp.tipo : undefined;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.desde ?? '') ? `${sp.desde}T00:00:00.000Z` : undefined;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.hasta ?? '') ? `${sp.hasta}T23:59:59.999Z` : undefined;
  const q = (sp.q ?? '').trim() || undefined;

  const [activities, members, flash, custOptions, oppRows] = await Promise.all([
    listActivities(db, { orgId: org.orgId, type, createdBy: sp.responsable || undefined, customerId: sp.cliente || undefined, from, to, q, limit: 200 }),
    listMembers(db, org.orgId),
    readFlash(),
    listCustomers(db, { orgId: org.orgId, userId: session.user.id, owner: 'all', limit: 400 }),
    can(session, 'opportunities:read') ? listOpportunities(db, { orgId: org.orgId, status: 'open', limit: 400 }) : Promise.resolve([]),
  ]);
  const customers = custOptions.items;
  const [linkedCustomers, linkedOpps] = await Promise.all([
    getCustomersByIds(db, [...new Set(activities.map((a) => a.customerId))]),
    getOpportunitiesByIds(db, [...new Set(activities.flatMap((a) => (a.opportunityId ? [a.opportunityId] : [])))]),
  ]);
  const cName = new Map(linkedCustomers.map((c) => [c.id, c.fullName]));
  const oTitle = new Map(linkedOpps.map((o) => [o.id, o.title]));
  const nameOf = (uid: string | null) => { const m = members.find((x) => x.userId === uid); return uid ? (m?.fullName ?? m?.email ?? 'Alguien') : 'Alguien'; };

  const custOpts: Opt[] = customers.map((c) => ({ id: c.id, name: c.fullName }));
  const oppOpts: OppOpt[] = oppRows.map((o) => ({ id: o.id, title: o.title, customerId: o.customerId }));

  const fmtTime = new Intl.DateTimeFormat('es', { hour: 'numeric', minute: '2-digit', timeZone: org.orgTimezone });
  const groups = groupActivitiesByDay(activities, new Date(), org.orgTimezone);

  const hasFilters = !!(type || sp.responsable || sp.cliente || from || to || q);

  return (
    <>
      <header className="page-head">
        <h1>Actividades</h1>
        <p className="muted">El historial de lo que ya pasó con tus clientes: llamadas, reuniones, correos y notas. No se editan: un error se corrige con una nota nueva.</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <div className="flt-bar">
        <SearchInput basePath="/activities" initial={sp.q ?? ''} placeholder="Buscar en el resumen" />
        <FilterSelect basePath="/activities" param="tipo" label="Tipo" value={sp.tipo ?? ''} options={ACTIVITY_TYPES.map((t) => ({ value: t, label: ACTIVITY_TYPE_LABEL[t] ?? t }))} />
        <FilterSelect basePath="/activities" param="cliente" label="Cliente" value={sp.cliente ?? ''} options={custOpts.slice(0, 300).map((c) => ({ value: c.id, label: c.name }))} />
        <FilterSelect basePath="/activities" param="responsable" label="Responsable" value={sp.responsable ?? ''} options={members.filter((m) => m.status === 'active').map((m) => ({ value: m.userId, label: m.fullName ?? m.email ?? 'Sin nombre' }))} />
        <DateFilter basePath="/activities" param="desde" label="Desde" value={sp.desde ?? ''} />
        <DateFilter basePath="/activities" param="hasta" label="Hasta" value={sp.hasta ?? ''} />
        {can(session, 'customers:update') && custOpts.length > 0 ? (
          <NewActivityModal trigger={<button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }}>+ Registrar actividad</button>} customers={custOpts} opportunities={oppOpts} />
        ) : null}
      </div>
      {hasFilters ? <p className="hint"><Link href="/activities">Quitar filtros</Link> · {activities.length} {activities.length === 1 ? 'resultado' : 'resultados'}</p> : null}

      {activities.length === 0 ? (
        <div className="empty-state"><strong>{hasFilters ? 'Nada coincide con estos filtros.' : 'Todavía no hay actividades registradas.'}</strong><p>Registra llamadas, reuniones, correos o visitas para llevar el historial de cada cliente.</p></div>
      ) : (
        <div className="stack">
          {groups.map((g) => (
            <div key={g.key} className="activity-day">
              <h2 className="activity-day-head">{g.heading}</h2>
              <div>
                {g.items.map((a) => (
                  <div key={a.id} className="activity-item">
                    <span className="activity-ico" aria-hidden="true"><Icon name={ACTIVITY_TYPE_ICON[a.type as keyof typeof ACTIVITY_TYPE_ICON] ?? 'file'} size={16} /></span>
                    <div className="activity-body">
                      <p className="activity-summary">{a.summary}</p>
                      <p className="activity-meta">
                        {fmtTime.format(new Date(a.occurredAt))} · {ACTIVITY_TYPE_LABEL[a.type as keyof typeof ACTIVITY_TYPE_LABEL] ?? a.type}
                        {a.direction ? ` · ${DIRECTION_LABEL[a.direction] ?? a.direction}` : ''}
                        {' · '}<Link href={`/customers/${a.customerId}`}>{cName.get(a.customerId) ?? 'Cliente'}</Link>
                        {a.opportunityId ? <> · <Link href={`/opportunities/${a.opportunityId}`}>{oTitle.get(a.opportunityId) ?? 'Oportunidad'}</Link></> : null}
                        {' · '}{nameOf(a.createdBy)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
