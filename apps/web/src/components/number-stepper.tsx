"use client";

import { useState } from "react";

export function NumberStepper({
  defaultValue,
  label,
  max,
  min,
  name,
  required = false,
  step,
  unit,
}: Readonly<{
  defaultValue: number;
  label: string;
  max: number;
  min: number;
  name: string;
  required?: boolean;
  step: number;
  unit?: string;
}>) {
  const [current, setCurrent] = useState(defaultValue);
  const change = (direction: -1 | 1) => {
    const next = Math.round((current + direction * step) * 100) / 100;
    setCurrent(Math.min(max, Math.max(min, next)));
  };
  return (
    <label className="stepper-field">
      <span className="field-label">{label}</span>
      <span className="number-stepper">
        <button aria-label={`${label} -`} onClick={() => change(-1)} type="button">
          −
        </button>
        <span className="stepper-value">
          <input
            max={max}
            min={min}
            name={name}
            onChange={(event) => setCurrent(Number(event.target.value))}
            required={required}
            step={step}
            type="number"
            value={current}
          />
          {unit ? <small>{unit}</small> : null}
        </span>
        <button aria-label={`${label} +`} onClick={() => change(1)} type="button">
          +
        </button>
      </span>
    </label>
  );
}
