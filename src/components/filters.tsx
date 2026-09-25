'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './Icon';

/** Filtros genéricos que actualizan la URL sin recargar la página (mismo patrón que Oportunidades, sin atarse a su ruta). */

export function FilterSelect({ basePath, param, label, value, options, allLabel = 'Todos' }: {
  basePath: string; param: string; label: string; value: string; options: { value: string; label: string }[]; allLabel?: string;
}) {
  const router = useRouter();
  return (
    <label className={`flt-select${value ? ' is-active' : ''}`}>
      <span className="flt-select-label">{label}</span>
      <select
        className="flt-select-input"
        value={value}
        aria-label={label}
        onChange={(e) => {
          const p = new URLSearchParams(window.location.search);
          if (e.target.value) p.set(param, e.target.value); else p.delete(param);
          const s = p.toString();
          router.replace(s ? `${basePath}?${s}` : basePath, { scroll: false });
        }}
      >
        <option value="">{allLabel}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

/** Buscador en vivo: espera a que termines de escribir y actualiza la URL (parámetro `q`). */
export function SearchInput({ basePath, initial, placeholder }: { basePath: string; initial: string; placeholder: string }) {
  const router = useRouter();
  const [text, setText] = useState(initial);
  const first = useRef(true);
  const last = useRef(initial);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (text.trim() === last.current.trim()) return;
    const t = setTimeout(() => {
      last.current = text;
      const p = new URLSearchParams(window.location.search);
      if (text.trim()) p.set('q', text.trim()); else p.delete('q');
      const s = p.toString();
      router.replace(s ? `${basePath}?${s}` : basePath, { scroll: false });
    }, 350);
    return () => clearTimeout(t);
  }, [text, basePath, router]);

  return (
    <div className="flt-search" role="search">
      <span className="flt-search-ico" aria-hidden="true"><Icon name="search" size={16} /></span>
      <label className="sr-only" htmlFor="flt-q">{placeholder}</label>
      <input id="flt-q" type="search" value={text} onChange={(e) => setText(e.target.value)} maxLength={80} autoComplete="off" placeholder={placeholder} className="flt-search-input" />
    </div>
  );
}

/** Filtro de una fecha (Desde/Hasta): actualiza la URL sin recargar. */
export function DateFilter({ basePath, param, label, value }: { basePath: string; param: string; label: string; value: string }) {
  const router = useRouter();
  return (
    <label className="flt-select">
      <span className="flt-select-label">{label}</span>
      <input
        type="date"
        defaultValue={value}
        className="flt-select-input"
        onChange={(e) => {
          const p = new URLSearchParams(window.location.search);
          if (e.target.value) p.set(param, e.target.value); else p.delete(param);
          const s = p.toString();
          router.replace(s ? `${basePath}?${s}` : basePath, { scroll: false });
        }}
      />
    </label>
  );
}
