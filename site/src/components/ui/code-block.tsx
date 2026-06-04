import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  code: string;
  filename?: string;
  language?: string;
  className?: string;
}

export function CodeBlock({
  code,
  filename,
  language,
  className,
}: CodeBlockProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card/60 shadow-sm backdrop-blur",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-destructive/60" />
          <span className="size-2.5 rounded-full bg-amber-500/60" />
          <span className="size-2.5 rounded-full bg-emerald-500/60" />
          {filename ? (
            <span className="ml-3 font-mono text-xs text-muted-foreground">
              {filename}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {language ? (
            <span className="font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
              {language}
            </span>
          ) : null}
          <CopyButton value={code} label="Copy code" />
        </div>
      </div>
      <pre className="overflow-x-auto p-4 text-[0.8rem] leading-relaxed">
        <code className="font-mono text-card-foreground/90">{code}</code>
      </pre>
    </div>
  );
}
