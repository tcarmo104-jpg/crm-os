'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { HOME, locate } from '@/lib/nav';

/** «Dónde estoy»: grupo › módulo. En la portada, solo «Hoy». */
export function Breadcrumb() {
  const { group, item } = locate(usePathname());
  if (!item) return null;
  return (
    <nav className="crumbs" aria-label="Ruta de navegación">
      {group ? <><span>{group.label}</span><span className="sep" aria-hidden="true">›</span></> : null}
      {item === HOME || !item.href ? <span className="here" aria-current="page">{item.label}</span>
        : <Link className="here" href={item.href} aria-current="page">{item.label}</Link>}
    </nav>
  );
}
