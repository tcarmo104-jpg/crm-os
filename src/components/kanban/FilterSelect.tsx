'use client';

import { useRouter } from 'next/navigation';

/** Filtro que se aplica al elegir (sin botón): actualiza el tablero sin recargar la página. */
export function FilterSelect({ param, label, value, options, hrefBase, allLabel }: {
  param: string; label: string; value: string; options: { value: string; label: string }[]; hrefBase: string; allLabel: string;
}) {
  const router = useRouter();
  const active = value !== '';
  return (
    <label className={`kb-filter${active ? ' is-active' : ''}`}>
      <span className="kb-filter-label">{label}</span>
      <select className="kb-filter-select" value={value} aria-label={label}
        onChange={(e) => {
          const p = new URLSearchParams(hrefBase.split('?')[1] ?? '');
          p.delete('o');
          if (e.target.value) p.set(param, e.target.value); else p.delete(param);
          const s = p.toString();
          router.replace(s ? `/opportunities?${s}` : '/opportunities', { scroll: false });
        }}>
        <option value="">{allLabel}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
