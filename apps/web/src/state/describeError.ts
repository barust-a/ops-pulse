import type { ApiError } from '../api/apiError';
import { fr } from '../i18n/fr';

/** The French sentence shown for a failed request. */
export function describeError(error: ApiError): string {
  return fr.status.errors[error.code];
}
