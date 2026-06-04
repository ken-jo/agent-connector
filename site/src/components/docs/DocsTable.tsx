import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { FieldRow } from "./docs-data";

/* ------------------------------------------------------------------ */
/* Generic table shell — styled to match the neutral theme            */
/* ------------------------------------------------------------------ */

export function DocsTable({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "not-prose my-6 overflow-x-auto rounded-xl border border-border bg-card/40 shadow-sm",
        className,
      )}
    >
      <table className="w-full border-collapse text-left text-sm">
        {children}
      </table>
    </div>
  );
}

export function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b border-border bg-muted/40 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td
      className={cn(
        "border-b border-border/60 px-4 py-3 align-top text-foreground/90",
        className,
      )}
    >
      {children}
    </td>
  );
}

/** A monospace token for types / paths / defaults. */
export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-md border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[0.78rem] text-foreground/90">
      {children}
    </code>
  );
}

/* ------------------------------------------------------------------ */
/* Field table — name / type / default / notes                        */
/* ------------------------------------------------------------------ */

export function FieldTable({ rows }: { rows: FieldRow[] }) {
  return (
    <DocsTable>
      <thead>
        <tr>
          <Th>Field</Th>
          <Th>Type</Th>
          <Th>Default</Th>
          <Th>Notes</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <Td className="whitespace-nowrap">
              <span className="inline-flex items-center gap-2">
                <code className="font-mono text-[0.82rem] font-medium text-foreground">
                  {r.name}
                </code>
                {r.required ? (
                  <Badge variant="muted" className="px-1.5 py-0 text-[0.6rem]">
                    required
                  </Badge>
                ) : null}
              </span>
            </Td>
            <Td>
              <Code>{r.type}</Code>
            </Td>
            <Td className="whitespace-nowrap">
              {r.default ? (
                <Code>{r.default}</Code>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </Td>
            <Td className="text-muted-foreground">{r.notes}</Td>
          </tr>
        ))}
      </tbody>
    </DocsTable>
  );
}
