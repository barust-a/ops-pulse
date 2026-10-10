import { Navigate, useLocation } from 'react-router';
import { z } from 'zod';

import { LoginForm } from '../features/auth/LoginForm';
import { fr } from '../i18n/fr';
import { useAuth } from '../state/auth/AuthContext';

const RedirectStateSchema = z.object({ from: z.string().startsWith('/') });

/** Where to go after signing in: the protected page that sent the user here, else home. */
function useRedirectTarget(): string {
  const location = useLocation();
  const parsed = RedirectStateSchema.safeParse(location.state);
  return parsed.success ? parsed.data.from : '/';
}

export function LoginPage() {
  const { state } = useAuth();
  const target = useRedirectTarget();
  if (state.status === 'authenticated') return <Navigate to={target} replace />;
  return (
    <main className="login-page">
      <div className="login-card">
        <div className="brand brand--large">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">{fr.app.name}</span>
        </div>
        <h1 className="login-card__title">{fr.login.title}</h1>
        <p className="login-card__subtitle">{fr.login.subtitle}</p>
        <LoginForm />
      </div>
    </main>
  );
}
