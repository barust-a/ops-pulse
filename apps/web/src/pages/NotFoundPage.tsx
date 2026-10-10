import { Link } from 'react-router';

import { fr } from '../i18n/fr';
import { PageHeader } from '../ui/PageHeader';

export function NotFoundPage() {
  return (
    <>
      <PageHeader title={fr.app.notFoundTitle} subtitle={fr.app.notFoundBody} />
      <Link className="button button--secondary" to="/">
        {fr.app.backHome}
      </Link>
    </>
  );
}
