import Form from 'next/form';
import Link from 'next/link';
import {
  CLOSE_OPTIONS, CREATED_OPTIONS, OPP_CHANNELS, OPP_CHANNEL_LABEL, PRIORITIES, PRIORITY_LABEL, TEMPERATURES, TEMPERATURE_LABEL, activeFilterCount, kanbanHref,
  type KanbanQuery,
} from '@/lib/kanban';
import type { PipelineRow, StageRow } from '@/lib/types';
import { Ico } from '@/components/inbox/icons';
import { FilterSelect } from './FilterSelect';
import { SearchBox } from './SearchBox';

interface Opt { value: string; label: string }

export function FilterBar({
  query, hrefBase, pipelines, pipelineId, stages, advisors, teams, products, cities,
}: {
  query: KanbanQuery; hrefBase: string; pipelines: PipelineRow[]; pipelineId: string; stages: StageRow[]; advisors: Opt[]; teams: Opt[]; products: Opt[]; cities: string[];
}) {
  const n = activeFilterCount(query);
  const chips: { label: string; clear: Partial<KanbanQuery> }[] = [];
  const name = (list: Opt[], v: string) => list.find((o) => o.value === v)?.label ?? '—';
  if (query.asesor) chips.push({ label: `Asesor: ${query.asesor === 'none' ? 'Sin asignar' : name(advisors, query.asesor)}`, clear: { asesor: '' } });
  if (query.equipo) chips.push({ label: `Equipo: ${name(teams, query.equipo)}`, clear: { equipo: '' } });
  if (query.region) chips.push({ label: `Región: ${query.region}`, clear: { region: '' } });
  if (query.canal) chips.push({ label: `Canal: ${OPP_CHANNEL_LABEL[query.canal]}`, clear: { canal: '' } });
  if (query.producto) chips.push({ label: `Producto: ${name(products, query.producto)}`, clear: { producto: '' } });
  if (query.etapa) chips.push({ label: `Etapa: ${stages.find((s) => s.id === query.etapa)?.name ?? '—'}`, clear: { etapa: '' } });
  if (query.prioridad) chips.push({ label: `Prioridad: ${PRIORITY_LABEL[query.prioridad]}`, clear: { prioridad: '' } });
  if (query.temperatura) chips.push({ label: `Temperatura: ${TEMPERATURE_LABEL[query.temperatura]}`, clear: { temperatura: '' } });
  if (query.creada) chips.push({ label: `Creada: ${CREATED_OPTIONS.find((c) => c.key === query.creada)?.label}`, clear: { creada: '' } });
  if (query.cierre) chips.push({ label: `Cierre: ${CLOSE_OPTIONS.find((c) => c.key === query.cierre)?.label}`, clear: { cierre: '' } });
  if (query.min || query.max) chips.push({ label: `Valor: ${query.min || '0'} – ${query.max || '∞'}`, clear: { min: '', max: '' } });
  const clearAll = kanbanHref({ ...query, asesor: '', equipo: '', region: '', canal: '', producto: '', etapa: '', prioridad: '', temperatura: '', creada: '', cierre: '', min: '', max: '', o: '' });

  return (
    <div className="kb-filters">
      <div className="kb-filters-row">
        <SearchBox initial={query.q} hrefBase={hrefBase} />
        <nav className="kb-views" aria-label="Vista">
          <Link href={kanbanHref(query, { vista: '' })} scroll={false} className={query.vista === '' ? 'is-active' : ''}>Tablero</Link>
          <Link href={kanbanHref(query, { vista: 'lista' })} scroll={false} className={query.vista === 'lista' ? 'is-active' : ''}>Lista</Link>
        </nav>
        {pipelines.length > 1 ? (
          <FilterSelect param="pipeline" label="Pipeline" value={pipelineId} allLabel="Pipeline" hrefBase={hrefBase} options={pipelines.map((p) => ({ value: p.id, label: p.name }))} />
        ) : null}
      </div>

      <div className="kb-filters-row kb-quick">
        <FilterSelect param="asesor" label="Asesor" value={query.asesor} allLabel="Todos" hrefBase={hrefBase} options={[{ value: 'none', label: 'Sin asignar' }, ...advisors]} />
        <FilterSelect param="canal" label="Canal" value={query.canal} allLabel="Todos" hrefBase={hrefBase} options={OPP_CHANNELS.map((c) => ({ value: c, label: OPP_CHANNEL_LABEL[c] }))} />
        <FilterSelect param="prioridad" label="Prioridad" value={query.prioridad} allLabel="Todas" hrefBase={hrefBase} options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))} />
        <FilterSelect param="temperatura" label="Temperatura" value={query.temperatura} allLabel="Todas" hrefBase={hrefBase} options={TEMPERATURES.map((t) => ({ value: t, label: TEMPERATURE_LABEL[t] }))} />
        <details className="kb-more" open={chips.some((c) => ['equipo', 'region', 'producto', 'etapa', 'creada', 'cierre', 'min'].some((k) => k in c.clear))}>
          <summary><Ico name="filter" size={14} /> Más filtros{n > 0 ? <span className="kb-badge">{n}</span> : null}</summary>
          <div className="kb-more-pop">
            <FilterSelect param="equipo" label="Equipo" value={query.equipo} allLabel="Todos" hrefBase={hrefBase} options={teams} />
            <FilterSelect param="producto" label="Producto" value={query.producto} allLabel="Todos" hrefBase={hrefBase} options={products} />
            <FilterSelect param="etapa" label="Etapa" value={query.etapa} allLabel="Todas" hrefBase={hrefBase} options={stages.map((s) => ({ value: s.id, label: s.name }))} />
            <FilterSelect param="creada" label="Fecha de creación" value={query.creada} allLabel="Cualquiera" hrefBase={hrefBase} options={CREATED_OPTIONS.map((c) => ({ value: c.key, label: c.label }))} />
            <FilterSelect param="cierre" label="Cierre estimado" value={query.cierre} allLabel="Cualquiera" hrefBase={hrefBase} options={CLOSE_OPTIONS.map((c) => ({ value: c.key, label: c.label }))} />
            <Form action="/opportunities" className="kb-more-form">
              {(['q', 'asesor', 'equipo', 'canal', 'producto', 'etapa', 'prioridad', 'temperatura', 'creada', 'cierre', 'pipeline', 'vista'] as const).map((k) => (query[k] ? <input key={k} type="hidden" name={k} value={query[k]} /> : null))}
              <label className="kb-filter"><span className="kb-filter-label">Región (ciudad del cliente)</span>
                <input name="region" list="kb-cities" defaultValue={query.region} maxLength={60} placeholder="Ej.: Medellín" className="kb-input" autoComplete="off" />
                <datalist id="kb-cities">{cities.map((c) => <option key={c} value={c} />)}</datalist>
              </label>
              <label className="kb-filter"><span className="kb-filter-label">Valor mínimo</span><input name="min" inputMode="decimal" defaultValue={query.min} className="kb-input" placeholder="0" /></label>
              <label className="kb-filter"><span className="kb-filter-label">Valor máximo</span><input name="max" inputMode="decimal" defaultValue={query.max} className="kb-input" placeholder="Sin límite" /></label>
              <button type="submit" className="kb-btn kb-btn--primary kb-btn--sm">Aplicar</button>
            </Form>
          </div>
        </details>
      </div>

      {chips.length > 0 ? (
        <div className="kb-chips" aria-label="Filtros activos">
          {chips.map((c) => <Link key={c.label} className="kb-chip" scroll={false} href={kanbanHref(query, { ...c.clear, o: '' })}>{c.label}<span aria-hidden="true">✕</span><span className="sr-only">quitar filtro</span></Link>)}
          <Link href={clearAll} scroll={false} className="kb-chip kb-chip--clear">Limpiar todo</Link>
        </div>
      ) : null}
    </div>
  );
}
