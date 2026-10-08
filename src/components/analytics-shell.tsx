'use client';

/**
 * El «marco» de Analítica: pestañas, filtros globales y contenido. Vive en el layout de /analytics, así que al
 * cambiar de pestaña o de filtro NO se vuelve a pintar: solo cambia el contenido, dentro de una transición de
 * React (el contenido actual queda visible y atenuado, con una barra de progreso arriba, hasta que llega el nuevo).
 *
 * La barra y las pestañas muestran lo ÚLTIMO que la persona pidió, aunque todavía esté cargando: cada cambio se
 * construye sobre el anterior, así que dos cambios seguidos (equipo y luego canal) no se pisan. Nunca hay dos
 * navegaciones en vuelo a la vez (ver `navRequest` en lib/analytics.ts): así los datos siempre corresponden a la
 * URL. Los filtros viven en la URL: se pueden compartir, y «atrás»/«adelante» del navegador funcionan.
 */
import { createContext, useContext, useEffect, useRef, useState, useTransition, type MouseEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  ANALYTICS_TABS, DATE_PRESETS, DATE_PRESET_LABEL, GLOBAL_FILTER_PARAMS, NAV_IDLE, navCommitted, navRequest, readGlobalFilters, tabHref, tabOf, withGlobalFilters,
  type DatePreset, type GlobalFilterKey, type GlobalFilterValue, type NavQueue,
} from '@/lib/analytics';

interface NavState { pending: boolean; path: string; params: URLSearchParams; go: (href: string) => void }
const Nav = createContext<NavState>({ pending: false, path: '/analytics', params: new URLSearchParams(), go: () => {} });

export function AnalyticsShell({ children, tabs, filters }: { children: ReactNode; tabs: ReactNode; filters: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const committed = sp.toString() ? `${pathname}?${sp}` : pathname;
  const [pending, start] = useTransition();
  const [queue, setQueue] = useState<NavQueue>(NAV_IDLE);
  const [shown, setShown] = useState(committed);       // lo confirmado (se actualiza al confirmarse)
  const queueRef = useRef<NavQueue>(NAV_IDLE);
  const timers = useRef<number[]>([]);
  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  const update = (q: NavQueue) => { queueRef.current = q; setQueue(q); };

  const navigate = (href: string) => {
    clearTimers();
    start(() => router.push(href, { scroll: false }));
    // Red de seguridad: a veces el router de Next deja sin confirmar una navegación que solo cambia los
    // parámetros (?…) de la misma página: el render nuevo queda suspendido y nunca se muestra (comprobado en
    // navegador real, también en pantallas existentes como Leads). Si a los 2,5 s no llegó, se reintenta; si a
    // los 6 s sigue sin llegar, se carga la página completa con lo último pedido (siempre funciona).
    const stuck = () => queueRef.current.inFlight === href;
    timers.current = [
      window.setTimeout(() => { if (stuck()) start(() => router.push(href, { scroll: false })); }, 2500),
      window.setTimeout(() => { if (stuck()) window.location.assign(queueRef.current.queued ?? href); }, 6000),
    ];
  };

  // Al confirmarse una URL (efecto: nunca durante el render, que puede quedar suspendido y no mostrarse).
  useEffect(() => {
    setShown(committed);
    const r = navCommitted(queueRef.current, committed);
    if (r.queue.inFlight !== queueRef.current.inFlight) clearTimers();
    update(r.queue);
    if (r.navigate) navigate(r.navigate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed]);
  useEffect(() => clearTimers, []);

  const go = (href: string) => {
    const latest = queueRef.current.queued ?? queueRef.current.inFlight ?? shown;
    if (href === latest) return;
    const r = navRequest(queueRef.current, href);
    update(r.queue);
    if (r.navigate) navigate(r.navigate);
  };
  const intent = queue.queued ?? queue.inFlight ?? shown;
  const [path, qs = ''] = intent.split('?');
  const loading = pending || queue.inFlight !== null;
  return (
    <Nav.Provider value={{ pending: loading, path: path!, params: new URLSearchParams(qs), go }}>
      {loading ? <div className="an-progress" role="progressbar" aria-label="Cargando" /> : null}
      {tabs}
      {filters}
      <div className="an-content" data-pending={loading} aria-busy={loading}>{children}</div>
    </Nav.Provider>
  );
}

/** Pestañas: enlaces reales (se pueden abrir en otra pestaña del navegador), pero un clic normal navega dentro
 * de la transición. La pestaña elegida se marca al instante, y viajan los filtros globales. */
export function AnalyticsTabs() {
  const { go, path, params } = useContext(Nav);
  const current = tabOf(path);
  const onClick = (href: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(href);
  };
  return (
    <nav className="an-tabs" aria-label="Secciones de Analítica">
      {ANALYTICS_TABS.map((t) => {
        const href = tabHref(t, params);
        // Sin prefetch: al cambiar un filtro, el enlace de la pestaña activa pasa a ser justo la URL a la que se está
        // navegando, y el prefetch de Next (que con loading.tsx trae solo el esqueleto) cancelaba esa navegación en
        // curso: el filtro quedaba marcado pero la pantalla no cambiaba. Comprobado en navegador real.
        return <Link key={t.key} href={href} prefetch={false} onClick={onClick(href)} aria-current={t.key === current.key ? 'page' : undefined}>{t.label}</Link>;
      })}
    </nav>
  );
}

type Opt = { value: string; label: string };

/** Filtros globales, siempre arriba y en el mismo lugar. Cada cambio se aplica al instante a la pestaña activa.
 * Los que no aplican en la pestaña actual se ven atenuados (y una nota dice por qué), pero se pueden cambiar:
 * se conservan para las demás pestañas. */
export function AnalyticsFilters({ people, teams, channels }: { people: Opt[]; teams: Opt[]; channels: string[] }) {
  const { go, path, params } = useContext(Nav);
  const tab = tabOf(path);
  const f = readGlobalFilters(params);
  // «Personalizado» sin las dos fechas todavía: se muestran los campos, sin navegar hasta tenerlas.
  const [draft, setDraft] = useState<{ desde: string; hasta: string } | null>(null);

  const apply = (v: Partial<GlobalFilterValue>) => {
    const s = withGlobalFilters(params, { ...f, ...v });
    go(s ? `${path}?${s}` : path);
  };
  const clear = () => {
    const next = new URLSearchParams(params);
    for (const k of GLOBAL_FILTER_PARAMS) next.delete(k);
    setDraft(null);
    const s = next.toString();
    go(s ? `${path}?${s}` : path);
  };
  const setDate = (k: 'desde' | 'hasta', value: string) => {
    const d = { desde: draft?.desde ?? f.desde, hasta: draft?.hasta ?? f.hasta, [k]: value };
    if (d.desde && d.hasta) { setDraft(null); apply({ periodo: 'custom', desde: d.desde, hasta: d.hasta }); } else setDraft(d);
  };
  const periodo: DatePreset = draft ? 'custom' : f.periodo;
  const desde = draft?.desde ?? f.desde, hasta = draft?.hasta ?? f.hasta;
  const applies = (k: GlobalFilterKey) => tab.applies.includes(k);
  const anyActive = GLOBAL_FILTER_PARAMS.some((k) => params.has(k)) || draft !== null;

  return (
    <form className="an-filters" aria-label="Filtros" onSubmit={(e) => e.preventDefault()}>
      <div className="field" data-applies={applies('periodo')}>
        <label className="label small" htmlFor="af-periodo">Período</label>
        <select id="af-periodo" className="select" value={periodo} onChange={(e) => {
          const v = e.target.value as DatePreset;
          if (v === 'custom') { if (f.desde && f.hasta) apply({ periodo: v }); else setDraft({ desde: f.desde, hasta: f.hasta }); }
          else { setDraft(null); apply({ periodo: v }); }
        }}>
          {DATE_PRESETS.map((d) => <option key={d} value={d}>{DATE_PRESET_LABEL[d]}</option>)}
        </select>
      </div>
      {periodo === 'custom' ? (
        <>
          <div className="field" data-applies={applies('periodo')}>
            <label className="label small" htmlFor="af-desde">Desde</label>
            <input id="af-desde" type="date" className="input" value={desde} max={hasta || undefined} onChange={(e) => setDate('desde', e.target.value)} />
          </div>
          <div className="field" data-applies={applies('periodo')}>
            <label className="label small" htmlFor="af-hasta">Hasta</label>
            <input id="af-hasta" type="date" className="input" value={hasta} min={desde || undefined} onChange={(e) => setDate('hasta', e.target.value)} />
          </div>
        </>
      ) : null}
      {/* `key`: si el valor cambia desde afuera (atrás del navegador, «Limpiar»), el selector se reinicia con él. */}
      <MultiPicker key={`p:${f.personas.join(',')}`} id="af-personas" label="Asesor" allLabel="Todas las personas" options={people} value={f.personas} applies={applies('personas')} onChange={(v) => apply({ personas: v })} />
      <MultiPicker key={`e:${f.equipos.join(',')}`} id="af-equipos" label="Equipo" allLabel="Todos los equipos" options={teams} value={f.equipos} applies={applies('equipos')} onChange={(v) => apply({ equipos: v })} />
      <div className="field" data-applies={applies('canal')}>
        <label className="label small" htmlFor="af-canal">Canal</label>
        <select id="af-canal" className="select" value={f.canal} onChange={(e) => apply({ canal: e.target.value })}>
          <option value="">Todos los canales</option>
          {channels.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="an-filters-actions">
        {anyActive ? <button type="button" className="btn btn-ghost" onClick={clear}>Limpiar filtros</button> : null}
      </div>
      {tab.hint ? <p className="an-filters-note">{tab.hint}</p> : null}
    </form>
  );
}

/** Selección múltiple compacta (casillas en un desplegable), en lugar de una lista larga siempre abierta.
 * Se aplica UNA vez al cerrarse (clic afuera, Esc o clic en el propio selector), para poder marcar varias. */
function MultiPicker({ id, label, allLabel, options, value, applies, onChange }: {
  id: string; label: string; allLabel: string; options: Opt[]; value: string[]; applies: boolean; onChange: (v: string[]) => void;
}) {
  const [sel, setSel] = useState<string[]>(value);
  const ref = useRef<HTMLDetailsElement>(null);
  const latest = useRef({ sel, value, onChange });
  latest.current = { sel, value, onChange };
  useEffect(() => {
    const close = () => { if (ref.current?.open) ref.current.open = false; };
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, []);
  const onToggle = () => {
    const { sel: s, value: v, onChange: f } = latest.current;
    const same = s.length === v.length && s.every((x) => v.includes(x));
    if (!ref.current?.open && !same) f(s);
  };
  const summary = sel.length === 0 ? allLabel : sel.length === 1 ? (options.find((o) => o.value === sel[0])?.label ?? '1 seleccionado') : `${sel.length} seleccionados`;
  return (
    <div className="field" data-applies={applies}>
      <span className="label small" id={`${id}-l`}>{label}</span>
      <details className="an-picker" ref={ref} onToggle={onToggle}>
        <summary className="select" aria-labelledby={`${id}-l`} data-testid={id}>{summary}</summary>
        <div className="an-picker-menu" role="group" aria-labelledby={`${id}-l`}>
          {options.length === 0 ? <span className="muted small" style={{ padding: 8 }}>No hay opciones.</span> : options.map((o) => (
            <label key={o.value}><input type="checkbox" checked={sel.includes(o.value)} onChange={() => setSel(sel.includes(o.value) ? sel.filter((x) => x !== o.value) : [...sel, o.value])} />{o.label}</label>
          ))}
        </div>
      </details>
    </div>
  );
}
