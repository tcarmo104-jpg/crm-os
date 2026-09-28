import { DATE_PRESET_LABEL, DATE_PRESETS, type DatePreset } from '@/lib/analytics';

export interface DashFilterValue { periodo: DatePreset; desde?: string; hasta?: string; personas: string[]; equipos: string[]; canal?: string }

/** Filtros globales del Dashboard: un solo formulario (sin JavaScript), con «Aplicar» y «Limpiar». */
export function DashboardFilters({
  basePath, value, people, teams, channels,
}: { basePath: string; value: DashFilterValue; people: { id: string; name: string }[]; teams: { id: string; name: string }[]; channels: string[] }) {
  const hasFilters = value.personas.length > 0 || value.equipos.length > 0 || !!value.canal || value.periodo !== 'this_month';
  const chip = (label: string) => <span key={label} className="dash-chip">{label}</span>;

  return (
    <div className="stack" style={{ gap: 8 }}>
      <form action={basePath} method="get" className="dash-filters">
        <div className="field">
          <label className="label small" htmlFor="df-periodo">Período</label>
          <select id="df-periodo" name="periodo" className="select" defaultValue={value.periodo}>
            {DATE_PRESETS.map((p) => <option key={p} value={p}>{DATE_PRESET_LABEL[p]}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="label small" htmlFor="df-desde">Desde (si es personalizado)</label>
          <input id="df-desde" type="date" name="desde" defaultValue={value.desde ?? ''} className="input" />
        </div>
        <div className="field">
          <label className="label small" htmlFor="df-hasta">Hasta</label>
          <input id="df-hasta" type="date" name="hasta" defaultValue={value.hasta ?? ''} className="input" />
        </div>
        {people.length > 0 ? (
          <div className="field">
            <label className="label small" htmlFor="df-personas">Personas</label>
            <select id="df-personas" name="personas" multiple size={3} className="select" defaultValue={value.personas} style={{ minWidth: 160 }}>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        ) : null}
        {teams.length > 0 ? (
          <div className="field">
            <label className="label small" htmlFor="df-equipos">Equipos</label>
            <select id="df-equipos" name="equipos" multiple size={3} className="select" defaultValue={value.equipos} style={{ minWidth: 160 }}>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        ) : null}
        {channels.length > 0 ? (
          <div className="field">
            <label className="label small" htmlFor="df-canal">Canal</label>
            <select id="df-canal" name="canal" className="select" defaultValue={value.canal ?? ''}>
              <option value="">Todos</option>
              {channels.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        ) : null}
        <button type="submit" className="btn btn-primary">Aplicar filtros</button>
        {hasFilters ? <a href={basePath} className="btn btn-ghost">Limpiar</a> : null}
      </form>
      {hasFilters ? (
        <div className="dash-chips">
          <span className="small muted">Filtros activos:</span>
          {value.periodo !== 'this_month' ? chip(DATE_PRESET_LABEL[value.periodo]) : null}
          {value.personas.map((id) => chip(people.find((p) => p.id === id)?.name ?? id))}
          {value.equipos.map((id) => chip(teams.find((t) => t.id === id)?.name ?? id))}
          {value.canal ? chip(value.canal) : null}
        </div>
      ) : null}
    </div>
  );
}
