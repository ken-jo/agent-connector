import { ArrowDown, FileCode2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeBlock } from "@/components/ui/code-block";
import { Section, SectionHeading } from "@/components/sections/Section";
import { dialectSnippets, dialectSource } from "@/data";

export function WriteOnceTabs() {
  return (
    <Section id="dialects">
      <SectionHeading
        eyebrow="Write once → N dialects"
        title="The same server, every native format"
        description="Declare it once. agent-connector renders the right root key, fields and file layout for each host — mcpServers vs servers, JSON vs TOML, scalar vs array command."
      />

      <div className="mx-auto mt-12 max-w-3xl">
        {/* Source of truth */}
        <div className="mb-5 flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <FileCode2 className="size-4" />
          You author this once
        </div>
        <CodeBlock
          code={dialectSource.code}
          filename={dialectSource.filename}
          language={dialectSource.language}
        />

        <div className="my-7 flex items-center justify-center gap-3 text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          <span className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 font-mono text-xs">
            <ArrowDown className="size-3.5" />
            agent-connector install
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>

        {/* Rendered dialects */}
        <Tabs defaultValue={dialectSnippets[0]!.id}>
          <div className="flex flex-col items-center gap-3">
            <p className="text-sm text-muted-foreground">
              …rendered natively into each host:
            </p>
            <TabsList>
              {dialectSnippets.map((snippet) => (
                <TabsTrigger key={snippet.id} value={snippet.id}>
                  {snippet.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {dialectSnippets.map((snippet) => (
            <TabsContent key={snippet.id} value={snippet.id}>
              <CodeBlock
                code={snippet.code}
                filename={snippet.filename}
                language={snippet.language}
              />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </Section>
  );
}
