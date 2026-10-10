import { useId, type ReactNode } from 'react';

interface CardProps {
  readonly title: string;
  readonly hint?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/** A titled panel of the dashboard grid. */
export function Card({ title, hint, children, className = '' }: CardProps) {
  const titleId = useId();
  return (
    <section className={`card ${className}`.trim()} aria-labelledby={titleId}>
      <header className="card__header">
        <h2 className="card__title" id={titleId}>
          {title}
        </h2>
        {hint === undefined ? null : <p className="card__hint">{hint}</p>}
      </header>
      {children}
    </section>
  );
}
