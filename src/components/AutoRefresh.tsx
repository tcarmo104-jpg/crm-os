'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Refresca la pantalla cada cierto tiempo mientras la pestaña está visible (bandeja «casi en vivo»). */
export function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') router.refresh(); };
    const id = setInterval(tick, seconds * 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [router, seconds]);
  return null;
}
