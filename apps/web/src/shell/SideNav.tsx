// Left navigation. Groups follow spec section 9 exactly, in spec order, and
// only the items the session's permission set allows are rendered.
//
// With 60 plus destinations a flat list would be unreadable, so each group
// collapses. The group holding the active route is open on load, the rest stay
// closed until asked for.
import { useEffect, useState } from "react";
import { Icon } from "@krakatausteel/ui";
import { visibleNav, type NavGroup } from "../nav";
import { Link, useRouter } from "../router";

export interface SideNavProps {
  permissions: readonly string[];
  /** Called after a destination is chosen, so a mobile sheet can close. */
  onNavigate?: () => void;
}

function groupIdForPath(groups: readonly NavGroup[], path: string): string | null {
  const exact = groups.find((group) => group.items.some((item) => item.path === path));
  if (exact) return exact.id;
  const prefixed = groups.find((group) =>
    group.items.some((item) => item.path !== "/" && path.startsWith(item.path)),
  );
  return prefixed?.id ?? null;
}

export function SideNav({ permissions, onNavigate }: SideNavProps) {
  const { path } = useRouter();
  const groups = visibleNav(permissions);
  const activeGroup = groupIdForPath(groups, path);
  const [open, setOpen] = useState<readonly string[]>(() => (activeGroup ? [activeGroup] : []));

  useEffect(() => {
    if (activeGroup) setOpen((current) => (current.includes(activeGroup) ? current : [...current, activeGroup]));
  }, [activeGroup]);

  return (
    <nav className="sidenav" aria-label="Navigasi utama">
      {groups.map((group) => {
        const single = group.items.length === 1 && group.items[0].path === "/";
        const expanded = open.includes(group.id);

        if (single) {
          const item = group.items[0];
          const current = path === item.path;
          return (
            <Link
              key={group.id}
              to={item.path}
              className={current ? "sidenav-solo is-active" : "sidenav-solo"}
              aria-current={current ? "page" : undefined}
              onClick={onNavigate}
            >
              <Icon name={group.icon} size={18} />
              <span>{item.label}</span>
            </Link>
          );
        }

        return (
          <section className="sidenav-group" key={group.id}>
            <button
              type="button"
              className={group.id === activeGroup ? "sidenav-head is-active" : "sidenav-head"}
              aria-expanded={expanded}
              onClick={() =>
                setOpen((current) =>
                  current.includes(group.id)
                    ? current.filter((id) => id !== group.id)
                    : [...current, group.id],
                )
              }
            >
              <Icon name={group.icon} size={18} />
              <span className="sidenav-head-label">{group.label}</span>
              <span className="sidenav-count">{group.items.length}</span>
              <Icon name={expanded ? "chevronUp" : "chevronDown"} size={16} />
            </button>
            {expanded ? (
              <ul className="sidenav-list">
                {group.items.map((item) => {
                  const current = path === item.path;
                  return (
                    <li key={item.path}>
                      <Link
                        to={item.path}
                        className={current ? "sidenav-link is-active" : "sidenav-link"}
                        aria-current={current ? "page" : undefined}
                        onClick={onNavigate}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>
        );
      })}
    </nav>
  );
}
