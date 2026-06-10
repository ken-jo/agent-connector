import * as React from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { navGroups } from "./docs-data";

interface DocsSidebarProps {
  activeId: string;
  onNavigate?: () => void;
  className?: string;
}

const STORAGE_KEY = "agent-connector.docs.collapsed-groups";

/** Read the persisted set of collapsed group titles (best-effort). */
function readCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

export function DocsSidebar({
  activeId,
  onNavigate,
  className,
}: DocsSidebarProps) {
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() =>
    typeof window === "undefined" ? new Set() : readCollapsed(),
  );

  // The group that owns the currently-active section — it is force-open so the
  // scroll-spy highlight is never hidden inside a collapsed group.
  const activeGroupTitle = React.useMemo(() => {
    const g = navGroups.find((grp) => grp.items.some((i) => i.id === activeId));
    return g?.title;
  }, [activeId]);

  const toggle = React.useCallback((title: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return (
    <nav aria-label="Docs sections" className={cn("text-sm", className)}>
      <ul className="space-y-5">
        {navGroups.map((group) => {
          // Open when not explicitly collapsed, OR when it owns the active item.
          const isOpen =
            !collapsed.has(group.title) || group.title === activeGroupTitle;
          const panelId = `docs-group-${group.title.replace(/\s+/g, "-").toLowerCase()}`;
          return (
            <li key={group.title}>
              <button
                type="button"
                onClick={() => toggle(group.title)}
                aria-expanded={isOpen}
                aria-controls={panelId}
                className="group/btn mb-2 flex w-full items-center gap-1.5 px-3 font-mono text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronRight
                  className={cn(
                    "size-3 shrink-0 transition-transform",
                    isOpen && "rotate-90",
                  )}
                />
                {group.title}
                {group.audience ? (
                  <span
                    className={cn(
                      "ml-auto shrink-0 rounded-full border px-1.5 py-px font-mono text-[0.58rem] font-medium normal-case tracking-normal",
                      group.audience === "cli-user"
                        ? "border-emerald-500/40 text-emerald-500"
                        : "border-blue-500/40 text-blue-400",
                    )}
                  >
                    {group.audience === "cli-user" ? "🖥️ user" : "🔌 dev"}
                  </span>
                ) : null}
              </button>
              {isOpen ? (
                <ul
                  id={panelId}
                  className="space-y-0.5 border-l border-border"
                >
                  {group.items.map((item) => {
                    const active = item.id === activeId;
                    return (
                      <li key={item.id}>
                        <Link
                          to={`/docs/${item.id}`}
                          onClick={onNavigate}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "-ml-px block border-l-2 py-1.5 pl-4 pr-3 transition-colors",
                            active
                              ? "border-foreground font-medium text-foreground"
                              : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                          )}
                        >
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
