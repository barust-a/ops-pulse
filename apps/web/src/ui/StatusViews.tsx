interface SkeletonProps {
  readonly label: string;
  readonly heightPx?: number;
}

/** A shimmering placeholder, announced once as "Chargement…" by its label. */
export function Skeleton({ label, heightPx = 120 }: SkeletonProps) {
  return (
    <div className="skeleton" style={{ height: heightPx }} role="status" aria-label={label} />
  );
}

interface EmptyStateProps {
  readonly title: string;
  readonly body?: string;
}

/** The panel shown when a request succeeded with nothing to show. */
export function EmptyState({ title, body }: EmptyStateProps) {
  return (
    <div className="state state--empty" role="status">
      <svg className="state__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 19h16M7 16V9m5 7V5m5 11v-4" />
      </svg>
      <p className="state__title">{title}</p>
      {body === undefined ? null : <p className="state__body">{body}</p>}
    </div>
  );
}

interface ErrorStateProps {
  readonly title: string;
  readonly message: string;
  readonly retryLabel: string;
  readonly onRetry: () => void;
}

/** The panel shown when a request failed, with a retry button. */
export function ErrorState({ title, message, retryLabel, onRetry }: ErrorStateProps) {
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">{title}</p>
      <p className="state__body">{message}</p>
      <button type="button" className="button button--secondary" onClick={onRetry}>
        {retryLabel}
      </button>
    </div>
  );
}
