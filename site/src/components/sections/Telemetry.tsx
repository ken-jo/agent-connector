import { Info } from "lucide-react";
import { Card } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Section, SectionHeading } from "@/components/sections/Section";
import { cn } from "@/lib/utils";
import {
  hostLeaderboard,
  mcpLeaderboard,
  type LeaderRow,
} from "@/data";

const confidenceStyles: Record<LeaderRow["confidence"], string> = {
  exact: "text-emerald-500",
  approx: "text-amber-500",
  heuristic: "text-muted-foreground",
};

const confidenceLabel: Record<LeaderRow["confidence"], string> = {
  exact: "tokenizer-exact",
  approx: "tokenizer-approx",
  heuristic: "heuristic",
};

function LeaderboardTable({
  title,
  icon,
  rows,
  unit,
}: {
  title: string;
  icon: string;
  rows: LeaderRow[];
  unit: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 px-1 pb-2 text-sm font-semibold text-foreground">
        <span aria-hidden="true">{icon}</span>
        {title}
      </div>
      <div className="overflow-x-auto rounded-lg border border-border bg-background/40">
        <table className="w-full min-w-[28rem] border-collapse font-mono text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium">RANK</th>
              <th className="px-3 py-2 font-medium">{unit}</th>
              <th className="px-3 py-2 text-right font-medium">CALLS</th>
              <th className="px-3 py-2 text-right font-medium">TOTAL TOKENS</th>
              <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">
                CONFIDENCE
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.rank}
                className="border-b border-border/60 last:border-0 transition-colors hover:bg-accent/40"
              >
                <td className="px-3 py-2 text-muted-foreground">
                  {row.rank === 1 ? "🥇" : `#${row.rank}`}
                </td>
                <td className="px-3 py-2 font-medium text-foreground">
                  {row.name}
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground">
                  {row.calls}
                </td>
                <td className="px-3 py-2 text-right text-foreground">
                  {row.tokens}
                </td>
                <td
                  className={cn(
                    "hidden px-3 py-2 text-right sm:table-cell",
                    confidenceStyles[row.confidence],
                  )}
                >
                  {confidenceLabel[row.confidence]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Telemetry() {
  return (
    <Section id="telemetry">
      <SectionHeading
        eyebrow="Token telemetry"
        title={
          <>
            Which of your tools actually{" "}
            <span className="text-gradient">cost context?</span>
          </>
        }
        description="agent-connector measures your server's own bytes — args in, results out, tool schemas — and tokenizes them locally. Two leaderboards, platform-independent, aggregate counts only."
      />

      <Card className="mx-auto mt-12 max-w-4xl overflow-hidden p-0">
        {/* Terminal chrome */}
        <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-destructive/60" />
            <span className="size-2.5 rounded-full bg-amber-500/60" />
            <span className="size-2.5 rounded-full bg-emerald-500/60" />
            <span className="ml-3 font-mono text-xs text-muted-foreground">
              agent-connector leaderboard
            </span>
          </div>
          <CopyButton value="agent-connector leaderboard" label="Copy command" />
        </div>

        <div className="space-y-7 p-5 sm:p-7">
          <p className="font-mono text-xs text-muted-foreground">
            <span className="text-emerald-500">$</span> agent-connector
            leaderboard --since 7d
          </p>

          <LeaderboardTable
            title="MCP / Plugin leaderboard"
            icon="🔌"
            rows={mcpLeaderboard}
            unit="CONNECTOR"
          />

          <LeaderboardTable
            title="Host / User leaderboard"
            icon="🖥️"
            rows={hostLeaderboard}
            unit="HOST"
          />

          <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/30 p-3.5 text-xs leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            <p>
              <span className="font-medium text-foreground">
                Never summed across origins.
              </span>{" "}
              Counts are estimates from the server's own I/O, not host-billed
              usage. Every record carries a confidence tag, and figures are kept
              local-first with zero egress by default —{" "}
              <code className="font-mono text-foreground">
                AGENT_CONNECTOR_TELEMETRY=0
              </code>{" "}
              to opt out.
            </p>
          </div>
        </div>
      </Card>
    </Section>
  );
}
