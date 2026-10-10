import { useEffect, useId, useRef, type ReactNode } from 'react';

interface SidePanelProps {
  readonly title: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/**
 * A non-modal panel beside the list. Focus moves to its title when it opens, and Escape or the
 * close button returns to the list.
 */
export function SidePanel({ title, closeLabel, onClose, children }: SidePanelProps) {
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, [title]);

  return (
    <aside
      className="side-panel"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <header className="side-panel__header">
        <h2 id={titleId} ref={titleRef} tabIndex={-1} className="side-panel__title">
          {title}
        </h2>
        <button type="button" className="icon-button" aria-label={closeLabel} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </header>
      {children}
    </aside>
  );
}
