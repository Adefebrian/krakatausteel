// MoneyInput. The only way a rupiah figure is typed anywhere in the product.
//
// It emits the API's `Uang` string ("1500000.00"), never a JavaScript number:
// the column is NUMERIC(20,2) and a float round trip is exactly how a rupiah
// figure loses its last cent. Parsing lives in ./money.ts, so the input side
// and the display side share one grammar.
//
// A value it cannot read is reported as `null` to the caller, never as zero.
// The submit button must stay closed over a null; sending 0,00 for something
// the operator typed and the field failed to read is the silent-zero bug this
// codebase already ruled out on the display side.
import { useEffect, useState, type InputHTMLAttributes } from "react";
import { parseUang, uangKeInput } from "./money";

export interface MoneyInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "value" | "onChange" | "type"> {
  /** The current `Uang` string, or "" for an empty field. */
  value: string;
  /** Receives the `Uang` string, or null when the text is not a figure. */
  onValueChange: (value: string | null, raw: string) => void;
  invalid?: boolean;
}

export function MoneyInput({ value, onValueChange, invalid, ...rest }: MoneyInputProps) {
  const [text, setText] = useState(() => uangKeInput(value));

  // Follow the caller when it sets the value from outside (a mitra lookup
  // prefilling a plafon, an approver page loading what was requested). Editing
  // is not disturbed: the effect only fires when the parsed value differs.
  useEffect(() => {
    if (parseUang(text) !== (value === "" ? null : value)) {
      setText(uangKeInput(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="control-with-affix has-leading">
      <span className="control-affix is-static is-leading" aria-hidden="true">
        Rp
      </span>
      <input
        {...rest}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={text}
        className={invalid ? "control has-leading is-numeric is-invalid" : "control has-leading is-numeric"}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          onValueChange(parseUang(next), next);
        }}
        onBlur={(event) => {
          const parsed = parseUang(text);
          if (parsed !== null) setText(uangKeInput(parsed));
          rest.onBlur?.(event);
        }}
      />
    </div>
  );
}
