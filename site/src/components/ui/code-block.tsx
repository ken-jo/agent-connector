import * as React from "react";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { highlightToHtml, normalizeLang } from "@/lib/highlighter";

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
  const lang = React.useMemo(() => normalizeLang(language), [language]);
  const [html, setHtml] = React.useState<string | null>(null);

  // Highlight lazily after mount. shiki + grammars are dynamically imported by
  // highlightToHtml, so nothing here lands in the initial chunk. Until the
  // async highlight resolves we show the raw code (same <pre> metrics → no
  // layout shift). A cancel flag avoids setting state after unmount / re-render.
  React.useEffect(() => {
    if (!lang) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    setHtml(null);
    highlightToHtml(code, lang).then((result) => {
      if (!cancelled) setHtml(result);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

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
      {html ? (
        <div
          className="shiki-host overflow-x-auto p-4 text-[0.8rem] leading-relaxed"
          // Highlighted markup is produced locally by shiki from our own static
          // snippet strings — no user/network input flows in here.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto p-4 text-[0.8rem] leading-relaxed">
          <code className="font-mono text-card-foreground/90">{code}</code>
        </pre>
      )}
    </div>
  );
}
