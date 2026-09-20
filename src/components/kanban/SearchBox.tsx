'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ico } from '@/components/inbox/icons';

/**
 * Buscador en vivo: espera un instante a que termines de escribir y actualiza el tablero sin recargar la página.
 * `hrefFor(texto)` arma la dirección con los demás filtros ya aplicados.
 */
export function SearchBox({ initial, hrefBase }: { initial: string; hrefBase: string }) {
  const router = useRouter();
  const [text, setText] = useState(initial);
  const first = useRef(true);
  const last = useRef(initial);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (text.trim() === last.current.trim()) return;
    const t = setTimeout(() => {
      last.current = text;
      const p = new URLSearchParams(hrefBase.split('?')[1] ?? '');
      p.delete('o');
      if (text.trim()) p.set('q', text.trim()); else p.delete('q');
      const s = p.toString();
      router.replace(s ? `/opportunities?${s}` : '/opportunities', { scroll: false });
    }, 350);
    return () => clearTimeout(t);
  }, [text, hrefBase, router]);

  return (
    <div className="kb-search" role="search">
      <span className="kb-search-ico"><Ico name="search" size={16} /></span>
      <label className="sr-only" htmlFor="kb-q">Buscar oportunidades</label>
      <input id="kb-q" type="search" value={text} onChange={(e) => setText(e.target.value)} maxLength={80} autoComplete="off"
        placeholder="Buscar por cliente, oportunidad, teléfono, correo, producto o número" className="kb-search-input" />
    </div>
  );
}
