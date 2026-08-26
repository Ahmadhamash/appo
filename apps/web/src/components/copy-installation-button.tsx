"use client";

import { useState } from "react";

export function CopyInstallationButton(
  props: Readonly<{ copiedLabel: string; label: string; value: string }>,
) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="form-actions">
      <button
        className="button secondary-button"
        onClick={async () => {
          await navigator.clipboard.writeText(props.value);
          setCopied(true);
        }}
        type="button"
      >
        {props.label}
      </button>
      <span aria-live="polite" className="muted">
        {copied ? props.copiedLabel : ""}
      </span>
    </div>
  );
}
