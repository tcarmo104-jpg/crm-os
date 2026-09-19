import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Icon } from '@/components/Icon';
import { OrgSwitcher } from '@/components/OrgSwitcher';
import { Sidebar } from '@/components/Sidebar';
import { ThemeToggle } from '@/components/ThemeToggle';
import { BRAND_NAME } from '@/lib/brand';
import { NAV_GROUPS } from '@/lib/nav';
import { getSession } from '@/lib/session';
import { SIDEBAR_COOKIE, parseSidebarState } from '@/lib/sidebar-state';
import { logout } from '@/app/auth-actions';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.active) redirect('/onboarding');

  const sidebar = parseSidebarState((await cookies()).get(SIDEBAR_COOKIE)?.value);
  const displayName = session.user.fullName ?? session.user.email;

  return (
    <div className="shell">
      <a className="skip-link" href="#content">Saltar al contenido</a>
      {/* Interruptor del menú en móvil (sin JS de estado compartido). */}
      <input type="checkbox" id="nav-open" className="nav-open" tabIndex={-1} aria-hidden="true" />
      <Sidebar groups={NAV_GROUPS} initial={sidebar} brand={BRAND_NAME} />
      <label htmlFor="nav-open" className="scrim" aria-hidden="true" />

      <div className="main">
        <header className="topbar">
          <label htmlFor="nav-open" className="icon-btn menu-btn" aria-label="Abrir menú">
            <Icon name="menu" />
          </label>
          <OrgSwitcher
            orgs={session.memberships.map((m) => ({ id: m.orgId, name: m.orgName }))}
            activeId={session.active.orgId}
          />
          <span className="spacer" />
          <ThemeToggle />
          <div className="user">
            <div className="user-text">
              <span className="user-name">{displayName}</span>
              <span className="user-role">{session.active.roleName}</span>
            </div>
            <form action={logout}>
              <button className="icon-btn" type="submit" aria-label="Cerrar sesión" title="Cerrar sesión">
                <Icon name="logout" />
              </button>
            </form>
          </div>
        </header>
        <main id="content" className="page">{children}</main>
      </div>
    </div>
  );
}
