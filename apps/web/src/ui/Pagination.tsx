import { fr } from '../i18n/fr';

interface PaginationProps {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly onPageChange: (page: number) => void;
}

/** "Page 2 sur 7 · 154 résultats" with previous/next buttons under a table. */
export function Pagination({ page, pageSize, total, onPageChange }: PaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="pagination" aria-label={fr.pagination.label}>
      <p className="pagination__status" aria-live="polite">
        {fr.pagination.status(page, pageCount)} · {fr.pagination.total(total)}
      </p>
      <div className="pagination__buttons">
        <button
          type="button"
          className="button button--secondary"
          disabled={page <= 1}
          onClick={() => {
            onPageChange(page - 1);
          }}
        >
          {fr.pagination.previous}
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={page >= pageCount}
          onClick={() => {
            onPageChange(page + 1);
          }}
        >
          {fr.pagination.next}
        </button>
      </div>
    </nav>
  );
}
