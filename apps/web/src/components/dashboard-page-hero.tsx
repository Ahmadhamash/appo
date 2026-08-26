import type { ReactNode } from "react";

export function DashboardPageHero({
  description,
  eyebrow,
  icon,
  title,
  titleId,
}: Readonly<{
  description: string;
  eyebrow: string;
  icon: ReactNode;
  title: string;
  titleId: string;
}>) {
  return (
    <header className="page-heading workspace-page-hero">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1 id={titleId}>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      <span className="workspace-page-icon" aria-hidden="true">
        {icon}
      </span>
    </header>
  );
}
