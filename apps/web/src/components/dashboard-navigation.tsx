"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type DashboardNavigationItem = Readonly<{
  href: string;
  icon: string;
  label: string;
}>;

export type DashboardNavigationGroup = Readonly<{
  items: readonly DashboardNavigationItem[];
  label: string;
}>;

type DashboardNavigationProperties = Readonly<{
  ariaLabel: string;
  groups: readonly DashboardNavigationGroup[];
  menuLabel: string;
}>;

function NavigationGroups({
  ariaLabel,
  groups,
}: Readonly<Pick<DashboardNavigationProperties, "ariaLabel" | "groups">>) {
  const pathname = usePathname();

  return (
    <nav aria-label={ariaLabel} className="side-nav">
      {groups.map((group) => (
        <section className="nav-group" key={group.label}>
          <h2>{group.label}</h2>
          <div className="nav-links">
            {group.items.map((item) => {
              const isCurrent =
                pathname === item.href ||
                (item.href.endsWith("/dashboard") === false &&
                  pathname.startsWith(`${item.href}/`));

              return (
                <Link
                  aria-current={isCurrent ? "page" : undefined}
                  className={isCurrent ? "active" : undefined}
                  href={item.href}
                  key={item.href}
                >
                  <span aria-hidden="true" className="nav-icon">
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </nav>
  );
}

export function DashboardNavigation({
  ariaLabel,
  groups,
  menuLabel,
}: DashboardNavigationProperties) {
  return (
    <details className="portal-navigation">
      <summary aria-label={menuLabel}>
        <span aria-hidden="true" className="portal-navigation-icon">
          ⊞
        </span>
        <span className="portal-navigation-label">{menuLabel}</span>
        <span aria-hidden="true" className="portal-navigation-caret">
          ⌄
        </span>
      </summary>
      <div className="portal-navigation-panel">
        <NavigationGroups ariaLabel={ariaLabel} groups={groups} />
      </div>
    </details>
  );
}
