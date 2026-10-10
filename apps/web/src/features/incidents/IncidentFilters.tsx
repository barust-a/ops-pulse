import { useState, type SubmitEvent } from 'react';

import { IncidentStateSchema, type IncidentState } from '../../api/schemas';
import { fr } from '../../i18n/fr';
import { SelectField } from '../../ui/SelectField';
import { GlobalFilters } from '../shared/GlobalFilters';
import { STATE_OPTIONS } from '../shared/options';

interface IncidentFiltersProps {
  readonly state: IncidentState | null;
  readonly q: string;
  readonly onStateChange: (state: IncidentState | null) => void;
  readonly onSearch: (q: string) => void;
}

/** "Filtres": period, service, priority, state, then the text search applied on submit. */
export function IncidentFilters({ state, q, onStateChange, onSearch }: IncidentFiltersProps) {
  const [draft, setDraft] = useState(q);

  function handleSubmit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSearch(draft);
  }

  return (
    <section className="filter-bar" aria-label={fr.filters.label}>
      <GlobalFilters withPriority />
      <SelectField
        label={fr.filters.state}
        value={state ?? ''}
        emptyLabel={fr.filters.all}
        options={STATE_OPTIONS}
        onChange={(value) => {
          const parsed = IncidentStateSchema.safeParse(value);
          onStateChange(parsed.success ? parsed.data : null);
        }}
      />
      <form className="search-form" role="search" onSubmit={handleSubmit}>
        <label className="field__label" htmlFor="incident-search">
          {fr.filters.search}
        </label>
        <div className="search-form__row">
          <input
            id="incident-search"
            type="search"
            className="field__control"
            placeholder={fr.filters.searchPlaceholder}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
          <button type="submit" className="button button--secondary">
            {fr.filters.searchSubmit}
          </button>
        </div>
      </form>
    </section>
  );
}
