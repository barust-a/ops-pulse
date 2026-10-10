import { PrioritySchema } from '../../api/schemas';
import { fr } from '../../i18n/fr';
import { RANGE_PRESETS } from '../../state/filters/dateRange';
import { useFilters } from '../../state/filters/FiltersContext';
import { SelectField } from '../../ui/SelectField';
import { PRIORITY_OPTIONS, SERVICE_OPTIONS } from './options';

/** "Période" segmented control: 7 / 30 / 90 jours. */
function PeriodPicker() {
  const { filters, dispatch } = useFilters();
  return (
    <fieldset className="segmented">
      <legend className="field__label">{fr.filters.period}</legend>
      <div className="segmented__options">
        {RANGE_PRESETS.map((days) => (
          <label key={days} className="segmented__option">
            <input
              type="radio"
              name="period"
              value={days}
              checked={filters.rangeDays === days}
              onChange={() => {
                dispatch({ type: 'rangeChanged', rangeDays: days });
              }}
            />
            <span>{fr.filters.periodDays(days)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface GlobalFiltersProps {
  /** Only incident lists filter by priority; the KPI endpoints do not take it. */
  readonly withPriority?: boolean;
}

/** The filters shared across pages: period, service and (optionally) priority. */
export function GlobalFilters({ withPriority = false }: GlobalFiltersProps) {
  const { filters, dispatch } = useFilters();
  return (
    <>
      <PeriodPicker />
      <SelectField
        label={fr.filters.service}
        value={filters.service ?? ''}
        emptyLabel={fr.filters.all}
        options={SERVICE_OPTIONS}
        onChange={(value) => {
          dispatch({ type: 'serviceChanged', service: value === '' ? null : value });
        }}
      />
      {withPriority ? (
        <SelectField
          label={fr.filters.priority}
          value={filters.priority === null ? '' : String(filters.priority)}
          emptyLabel={fr.filters.allFeminine}
          options={PRIORITY_OPTIONS}
          onChange={(value) => {
            const parsed = PrioritySchema.safeParse(Number(value));
            dispatch({ type: 'priorityChanged', priority: parsed.success ? parsed.data : null });
          }}
        />
      ) : null}
    </>
  );
}
