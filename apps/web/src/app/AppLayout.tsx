import { Suspense, useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';

import { fr } from '../i18n/fr';
import { useAuth, useCurrentUser } from '../state/auth/AuthContext';
import { Skeleton } from '../ui/StatusViews';

const NAV_ITEMS = [
  { to: '/', label: fr.nav.overview, icon: 'M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6v-9h-6v9Zm0-16v5h6V4h-6Z' },
  { to: '/incidents', label: fr.nav.incidents, icon: 'M12 3 2 20h20L12 3Zm0 6v5m0 3v.5' },
  { to: '/changes', label: fr.nav.changes, icon: 'M4 7h13l-3-3m6 13H7l3 3' },
] as const;

/** "Ops Pulse" logo and the three section links. */
function MainNav() {
  return (
    <nav className="sidebar__nav" aria-label={fr.nav.label}>
      <ul>
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to} end={item.to === '/'} className="nav-link">
              <svg className="nav-link__icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d={item.icon} />
              </svg>
              <span>{item.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The signed-in user's e-mail, role badge ("Analyste") and "Se déconnecter". */
function UserMenu() {
  const user = useCurrentUser();
  const { logout } = useAuth();
  return (
    <section className="user-menu" aria-label={fr.user.menuLabel}>
      <span className="user-menu__avatar" aria-hidden="true">
        {user.email.slice(0, 1).toUpperCase()}
      </span>
      <span className="user-menu__email">{user.email}</span>
      <span className={`badge badge--role-${user.role}`}>{fr.user.roles[user.role]}</span>
      <button type="button" className="button button--ghost" onClick={logout}>
        {fr.user.logout}
      </button>
    </section>
  );
}

/** The authenticated shell: sidebar navigation, top bar with the user menu, page content. */
export function AppLayout() {
  const mainRef = useRef<HTMLElement>(null);
  const previousPathRef = useRef<string | null>(null);
  const { pathname } = useLocation();

  // Moves focus to the new page after a navigation (not on first load), so screen readers
  // announce it (WCAG 2.4.3).
  useEffect(() => {
    const isNavigation = previousPathRef.current !== null && previousPathRef.current !== pathname;
    previousPathRef.current = pathname;
    if (isNavigation) mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {fr.app.skipToContent}
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">{fr.app.name}</span>
        </div>
        <p className="sidebar__tagline">{fr.app.tagline}</p>
        <MainNav />
      </aside>
      <div className="shell__body">
        <header className="topbar">
          <UserMenu />
        </header>
        <main id="main" ref={mainRef} tabIndex={-1} className="content">
          <Suspense fallback={<Skeleton label={fr.status.loading} heightPx={480} />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
