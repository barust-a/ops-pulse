import { useId } from 'react';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

interface SelectFieldProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  /** Label of the empty option meaning "no filter" (or "pick one" in a form). */
  readonly emptyLabel?: string;
  readonly required?: boolean;
  readonly errorMessage?: string;
}

/** A labelled native select, with its error message linked for screen readers. */
export function SelectField(props: SelectFieldProps) {
  const { label, value, options, onChange, emptyLabel, required = false, errorMessage } = props;
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="field__control"
        value={value}
        required={required}
        aria-invalid={errorMessage === undefined ? undefined : true}
        aria-describedby={errorMessage === undefined ? undefined : errorId}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {emptyLabel === undefined ? null : <option value="">{emptyLabel}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {errorMessage === undefined ? null : (
        <p className="field__error" id={errorId}>
          {errorMessage}
        </p>
      )}
    </div>
  );
}
