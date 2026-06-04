import { cn } from "@/lib/utils";
import { navGroups } from "./docs-data";

interface DocsSidebarProps {
  activeId: string;
  onNavigate?: () => void;
  className?: string;
}

export function DocsSidebar({
  activeId,
  onNavigate,
  className,
}: DocsSidebarProps) {
  return (
    <nav
      aria-label="Docs sections"
      className={cn("text-sm", className)}
    >
      <ul className="space-y-7">
        {navGroups.map((group) => (
          <li key={group.title}>
            <p className="mb-2 px-3 font-mono text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {group.title}
            </p>
            <ul className="space-y-0.5 border-l border-border">
              {group.items.map((item) => {
                const active = item.id === activeId;
                return (
                  <li key={item.id}>
                    <a
                      href={`#${item.id}`}
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
                    </a>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}
