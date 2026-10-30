import { useId } from "react";
import { Input } from "../../components/ui/input";
import { useLocale } from "../../i18n";
import type { ImageTarget } from "../../lib/imaging/types";
import { validateParameters } from "./parameterModel";
import { parameterLabel, parameterValueLabel } from "./studioText";

export const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
export function TargetParameterForm({
  target,
  values,
  onChange,
  disabled,
}: {
  target: ImageTarget;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const prefix = useId();
  const { t } = useLocale();
  const errors = validateParameters(target, values);
  const set = (key: string, value: unknown) => {
    const next = { ...values };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {target.parameters.map((spec) => {
        const id = `${prefix}-${spec.key}`;
        const message = errors.find((error) => error.key === spec.key)?.message;
        const common = {
          id,
          disabled,
          "aria-invalid": !!message,
          "aria-describedby": message ? `${id}-error` : undefined,
          required: spec.required,
        };
        return (
          <div key={spec.key} className="min-w-0 space-y-1">
            <label htmlFor={id} className="text-xs font-medium">
              {parameterLabel(spec, t)}
              {spec.required ? " *" : ""}
              {spec.unit ? <span className="ml-1 text-muted-foreground">({spec.unit})</span> : null}
            </label>
            {spec.enum ? (
              <select
                {...common}
                className={selectClass}
                value={spec.enum.findIndex((value) => value === values[spec.key])}
                onChange={(event) => set(spec.key, spec.enum?.[Number(event.target.value)])}
              >
                <option value={-1}>请选择</option>
                {spec.enum.map((value, index) => (
                  <option key={`${typeof value}:${value}`} value={index}>
                    {typeof value === "boolean"
                      ? value
                        ? "是"
                        : "否"
                      : parameterValueLabel(spec, value, t)}
                  </option>
                ))}
              </select>
            ) : spec.type === "boolean" ? (
              <select
                {...common}
                className={selectClass}
                value={values[spec.key] === undefined ? "" : String(values[spec.key])}
                onChange={(event) =>
                  set(
                    spec.key,
                    event.target.value === "" ? undefined : event.target.value === "true",
                  )
                }
              >
                <option value="">请选择</option>
                <option value="true">是</option>
                <option value="false">否</option>
              </select>
            ) : (
              <Input
                {...common}
                type={spec.type === "string" ? "text" : "number"}
                min={spec.minimum}
                max={spec.maximum}
                step={spec.type === "integer" ? 1 : "any"}
                value={
                  typeof values[spec.key] === "string" || typeof values[spec.key] === "number"
                    ? String(values[spec.key])
                    : ""
                }
                onChange={(event) =>
                  set(
                    spec.key,
                    event.target.value === ""
                      ? undefined
                      : spec.type === "string"
                        ? event.target.value
                        : event.target.valueAsNumber,
                  )
                }
              />
            )}
            {message && (
              <p id={`${id}-error`} className="text-xs text-destructive">
                {message}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
