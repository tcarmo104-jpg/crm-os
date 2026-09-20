'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Contenedor con scroll del chat. Baja al último mensaje al abrir una conversación y cuando llega algo nuevo,
 * PERO solo si la persona ya estaba leyendo al final (si subió a revisar historial, no se le mueve la pantalla).
 */
export function ThreadScroll({ children, watch, resetKey }: { children: ReactNode; watch: number; resetKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
  }, [resetKey]);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [watch]);

  return (
    <div
      ref={ref}
      className="ib-thread"
      role="log"
      aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {children}
    </div>
  );
}
