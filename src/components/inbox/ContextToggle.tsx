'use client';

import { useState } from 'react';
import { INBOX_CONTEXT_COOKIE } from '@/lib/inbox-view';
import { Ico } from './icons';

/**
 * Abre/cierra la ficha del cliente SIN recargar nada: solo cambia un atributo del contenedor (la conversación,
 * el scroll y lo escrito en el compositor no se tocan).
 *  · ≥1200 px: colapsa/expande la columna (y lo recuerda en una cookie).
 *  · 860–1199 px: abre la ficha como panel lateral.
 *  · <860 px: cambia a la vista «Cliente».
 * `variant`: 'edge' (botón en el borde), 'header' (botón «Ficha» del encabezado) y 'close' (cerrar dentro de la ficha).
 */
export function ContextToggle({ variant, initialOpen = true }: { variant: 'edge' | 'header' | 'close'; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);

  const toggle = () => {
    const root = document.querySelector<HTMLElement>('.ib');
    if (!root) return;
    const w = window.innerWidth;
    if (w >= 1200) {
      const next = root.dataset.context === 'closed' ? 'open' : 'closed';
      root.dataset.context = next;
      document.cookie = `${INBOX_CONTEXT_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
      setOpen(next === 'open');
    } else if (w >= 860) {
      const next = root.dataset.sheet === 'open' ? 'closed' : 'open';
      root.dataset.sheet = next;
      setOpen(next === 'open');
    } else {
      root.dataset.view = variant === 'close' ? 'chat' : 'context';
    }
  };

  if (variant === 'header') {
    return <button type="button" className="ib-btn ib-btn--ghost ib-only-narrow" onClick={toggle}><Ico name="user" size={16} /> <span>Ficha</span></button>;
  }
  if (variant === 'close') {
    return <button type="button" className="ib-icon-btn ib-only-narrow" onClick={toggle} aria-label="Cerrar la ficha del cliente"><Ico name="x" size={18} /></button>;
  }
  return (
    <button type="button" className="ib-toggle" onClick={toggle} aria-label="Mostrar u ocultar la ficha del cliente" aria-expanded={open} title="Ficha del cliente">
      <Ico name="chevronRight" size={14} />
    </button>
  );
}
