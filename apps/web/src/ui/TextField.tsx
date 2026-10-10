import { useId, type InputHTMLAttributes } from 'react';

type NativeInputProps = Readonly<Pick<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'autoComplete' | 'placeholder' | 'required' | 'name'
>>;

interface TextFieldProps extends NativeInputProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly errorMessage?: string;
}

/** A labelled input, with its error message linked for screen readers. */
export function TextField({ label, value, onChange, errorMessage, ...native }: TextFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        {...native}
        id={id}
        className="field__control"
        value={value}
        aria-invalid={errorMessage === undefined ? undefined : true}
        aria-describedby={errorMessage === undefined ? undefined : errorId}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {errorMessage === undefined ? null : (
        <p className="field__error" id={errorId}>
          {errorMessage}
        </p>
      )}
    </div>
  );
}
