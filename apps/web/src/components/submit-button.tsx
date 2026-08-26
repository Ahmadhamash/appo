"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton({
  children,
  name,
  tone = "primary",
  value,
}: Readonly<{
  children: string;
  name?: string | undefined;
  tone?: "danger" | "primary" | "secondary";
  value?: string | undefined;
}>) {
  const { pending } = useFormStatus();
  return (
    <button
      className={`button button-${tone}`}
      disabled={pending}
      name={name}
      type="submit"
      value={value}
    >
      {children}
    </button>
  );
}
