'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { HOME, type NavGroup, type NavItem } from '@/lib/nav';
import { SIDEBAR_COOKIE, serializeSidebarState, type SidebarState } from '@/lib/sidebar-state';

function persist(state: SidebarState) {
  document.cookie = `${SIDEBAR_COOKIE}=${serializeSidebarState(state)}; path=/; max-age=31536000; samesite=lax`;
}

function Item({ item, collapsed, active }: { item: NavItem; collapsed: boolean; active: boolean }) {
  const inner = (
    <>
      <Icon name={item.icon} />
      <span className="nav-label">{item.label}</span>
      {item.phase ? <span className="nav-badge">Fase {item.phase}</span> : null}
    </>
  );
  if (!item.href) {
    return (
      <span
        className="nav-item is-soon"
        aria-disabled="true"
        title={`${item.label}: disponible en la fase ${item.phase}`}
      >
        {inner}
      </span>
    );
  }
  return (
    <Link
      href={item.href}
      className={`nav-item${active ? ' is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? item.label : undefined}
    >
      {inner}
    </Link>
  );
}

export function Sidebar({ groups, initial, brand }: { groups: NavGroup[]; initial: SidebarState; brand: string }) {
  const pathname = usePathname();
  const [state, setState] = useState<SidebarState>(initial);

  // En móvil, cerrar el menú al navegar.
  useEffect(() => {
    const box = document.getElementById('nav-open') as HTMLInputElement | null;
    if (box) box.checked = false;
  }, [pathname]);

  const update = (next: SidebarState) => {
    setState(next);
    persist(next);
  };

  const isActive = (item: NavItem) =>
    item.href === '/' ? pathname === '/' : Boolean(item.href && pathname.startsWith(item.href));

  return (
    <aside className={`sidebar${state.collapsed ? ' is-collapsed' : ''}`} aria-label="Navegación principal">
      <div className="sidebar-head">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">{brand}</span>
      </div>

      <nav className="sidebar-scroll">
        <div className="nav-list">
          <Item item={HOME} collapsed={state.collapsed} active={isActive(HOME)} />
        </div>

        {groups.map((g) => {
          const open = state.collapsed || !state.closed.includes(g.key);
          const hasAvailable = g.items.some((i) => i.href);
          return (
            <section className="nav-group" key={g.key}>
              {state.collapsed ? (
                <hr className="nav-divider" />
              ) : (
                <button
                  type="button"
                  className="nav-group-btn"
                  aria-expanded={open}
                  onClick={() =>
                    update({
                      ...state,
                      closed: open ? [...state.closed, g.key] : state.closed.filter((k) => k !== g.key),
                    })
                  }
                >
                  <span>{g.label}</span>
                  {!hasAvailable ? <span className="nav-soon-tag">Pronto</span> : null}
                  <span className={`chev${open ? ' is-open' : ''}`}>
                    <Icon name="chevron" size={14} />
                  </span>
                </button>
              )}
              {open ? (
                <div className="nav-list">
                  {g.items.map((item) => (
                    <Item key={item.key} item={item} collapsed={state.collapsed} active={isActive(item)} />
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
      </nav>

      <div className="sidebar-foot">
        <button
          type="button"
          className="nav-item nav-toggle"
          onClick={() => update({ ...state, collapsed: !state.collapsed })}
          aria-pressed={state.collapsed}
          title={state.collapsed ? 'Expandir menú' : 'Contraer menú'}
        >
          <Icon name="sidebar" />
          <span className="nav-label">{state.collapsed ? 'Expandir menú' : 'Contraer menú'}</span>
        </button>
      </div>
    </aside>
  );
}
