'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Panel lateral de detalle. Se abre sobre el tablero (sin salir de él), se cierra con Escape, con el fondo o con
 * la X, y devuelve el foco. El contenido lo arma el servidor; aquí solo vive la «cáscara».
 */
export function Drawer({ closeHref, title, children }: { closeHref: string; title: string; children: ReactNode }) {
  const router = useRouter();
  const ref = useRef<HTMLElement>(null);
  const close = () => router.push(closeHref, { scroll: false });

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') router.push(closeHref, { scroll: false }); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [closeHref, router]);

  return (
    <>
      <div className="kb-scrim" onClick={close} aria-hidden="true" />
      <aside ref={ref} className="kb-drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <button type="button" className="kb-drawer-close" onClick={close} aria-label="Cerrar el detalle">✕</button>
        {children}
      </aside>
    </>
  );
}
