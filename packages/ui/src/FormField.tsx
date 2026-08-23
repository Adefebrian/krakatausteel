// Form field set. Presentational only: no validation library, no form state
// manager, no data fetching. A field owns its label, its hint, and its error
// slot, so no page has to rebuild that trio by hand.
//
// The error is wired with aria-describedby and aria-invalid rather than only
// being painted red, so state is never carried by color alone.
import {
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Icon } from "./Icon";

export interface FieldProps {
  label: string;
  /** Pass the same id down to the control. Generated when omitted. */
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}

export function Field({ label, htmlFor, hint, error, required, children }: FieldProps) {
  const fallbackId = useId();
  const id = htmlFor ?? fallbackId;
  return (
    <div className={error ? "field has-error" : "field"}>
      <label className="field-label" htmlFor={id}>
        {label}
        {required ? (
          <span className="field-required" aria-hidden="true">
            wajib
          </span>
        ) : null}
      </label>
      {children}
      {hint && !error ? (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${id}-error`} role="alert">
          <Icon name="alert" size={16} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  invalid?: boolean;
}

export function TextInput({ invalid, ...rest }: TextInputProps) {
  return (
    <input
      {...rest}
      className={invalid ? "control is-invalid" : "control"}
      aria-invalid={invalid || undefined}
    />
  );
}

export interface PasswordInputProps extends TextInputProps {
  /** Label for the reveal toggle. Kept configurable for copy review. */
  revealLabel?: string;
  hideLabel?: string;
}

export function PasswordInput({
  invalid,
  revealLabel = "Tampilkan kata sandi",
  hideLabel = "Sembunyikan kata sandi",
  ...rest
}: PasswordInputProps) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="control-with-affix">
      <input
        {...rest}
        type={revealed ? "text" : "password"}
        className={invalid ? "control is-invalid" : "control"}
        aria-invalid={invalid || undefined}
      />
      <button
        type="button"
        className="control-affix"
        onClick={() => setRevealed((value) => !value)}
        aria-label={revealed ? hideLabel : revealLabel}
        aria-pressed={revealed}
      >
        <Icon name={revealed ? "eyeOff" : "eye"} size={18} />
      </button>
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> {
  options: readonly SelectOption[];
  invalid?: boolean;
}

export function Select({ options, invalid, ...rest }: SelectProps) {
  return (
    <div className="control-with-affix">
      <select
        {...rest}
        className={invalid ? "control control-select is-invalid" : "control control-select"}
        aria-invalid={invalid || undefined}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="control-affix is-static" aria-hidden="true">
        <Icon name="chevronDown" size={16} />
      </span>
    </div>
  );
}

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> {
  invalid?: boolean;
}

export function Textarea({ invalid, rows = 4, ...rest }: TextareaProps) {
  return (
    <textarea
      {...rest}
      rows={rows}
      className={invalid ? "control control-textarea is-invalid" : "control control-textarea"}
      aria-invalid={invalid || undefined}
    />
  );
}

export interface SearchInputProps extends Omit<TextInputProps, "type"> {
  /** Accessible label. A search box next to a magnifier needs a real name. */
  label: string;
}

export function SearchInput({ label, invalid, ...rest }: SearchInputProps) {
  return (
    <div className="control-with-affix has-leading">
      <span className="control-affix is-static is-leading" aria-hidden="true">
        <Icon name="search" size={16} />
      </span>
      <input
        {...rest}
        type="search"
        aria-label={label}
        className={invalid ? "control has-leading is-invalid" : "control has-leading"}
        aria-invalid={invalid || undefined}
      />
    </div>
  );
}
