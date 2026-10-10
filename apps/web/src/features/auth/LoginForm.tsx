import { useState, type SubmitEvent } from 'react';

import { toApiError } from '../../api/apiError';
import { LoginBodySchema } from '../../api/schemas';
import { fr } from '../../i18n/fr';
import { useAuth } from '../../state/auth/AuthContext';
import { TextField } from '../../ui/TextField';

const DEMO_EMAILS = ['admin@ops-pulse.test', 'analyst@ops-pulse.test', 'viewer@ops-pulse.test'];

interface FieldErrors {
  readonly email?: string;
  readonly password?: string;
}

function validate(email: string, password: string): FieldErrors {
  const errors: { email?: string; password?: string } = {};
  if (!LoginBodySchema.shape.email.safeParse(email.trim()).success) {
    errors.email = fr.login.emailInvalid;
  }
  if (password === '') errors.password = fr.login.passwordRequired;
  return errors;
}

function loginFailureMessage(error: unknown): string {
  const apiError = toApiError(error);
  if (apiError.code === 'UNAUTHENTICATED' || apiError.code === 'VALIDATION_FAILED') {
    return fr.login.invalidCredentials;
  }
  if (apiError.code === 'RATE_LIMITED') return fr.login.rateLimited;
  return fr.login.unavailable;
}

/** "Comptes de démonstration": the three seeded e-mails, never the password. */
function DemoAccounts() {
  return (
    <aside className="demo-accounts" aria-labelledby="demo-accounts-title">
      <h2 id="demo-accounts-title" className="demo-accounts__title">
        {fr.login.demoTitle}
      </h2>
      <ul className="demo-accounts__list">
        {DEMO_EMAILS.map((email) => (
          <li key={email}>
            <code>{email}</code>
          </li>
        ))}
      </ul>
      <p className="demo-accounts__hint">{fr.login.demoPassword}</p>
    </aside>
  );
}

/** The "Connexion" form: e-mail, password, inline errors, then the demo-account hint. */
export function LoginForm() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const fieldErrors = validate(email, password);
    setErrors(fieldErrors);
    setFailure(null);
    if (fieldErrors.email !== undefined || fieldErrors.password !== undefined) return;
    setSubmitting(true);
    try {
      await login({ email: email.trim(), password });
    } catch (error) {
      setFailure(loginFailureMessage(error));
      setSubmitting(false);
    }
  }

  return (
    <>
      <form className="login-form" noValidate onSubmit={(event) => void handleSubmit(event)}>
        <TextField
          label={fr.login.email}
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={setEmail}
          errorMessage={errors.email}
        />
        <TextField
          label={fr.login.password}
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={setPassword}
          errorMessage={errors.password}
        />
        {failure === null ? null : (
          <p className="form-alert" role="alert">
            {failure}
          </p>
        )}
        <button type="submit" className="button button--primary button--block" disabled={submitting}>
          {submitting ? fr.login.submitting : fr.login.submit}
        </button>
      </form>
      <DemoAccounts />
    </>
  );
}
