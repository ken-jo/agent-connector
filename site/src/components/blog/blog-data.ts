export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  date: string;
  category: "BUILDING" | "ECOSYSTEM";
  readingMinutes: number;
  heroImage: {
    src: string;
    alt: string;
    caption: string;
  };
  sections: {
    heading: string;
    body: string[];
  }[];
}

export const blogPosts: BlogPost[] = [
  {
    slug: "ucp-mcp-servers-every-agent-host",
    title: "Shopify's UCP MCP servers, installed into every agent host with one command",
    description:
      "The Universal Commerce Protocol runs over MCP, and Shopify now ships UCP-compliant MCP servers for catalog, cart, checkout and orders. Its quickstart installs them one AI tool at a time. This is what the same server looks like as an agent-connector package: one declaration, one install command, every detected agent host.",
    date: "2026-09-06",
    category: "ECOSYSTEM",
    readingMinutes: 4,
    heroImage: {
      src: "/blog/ucp-every-agent-host-cover.svg",
      alt: "A UCP business profile pointing at an MCP endpoint, one defineConnector declaration, and a column of agent hosts",
      caption: "UCP declares the MCP endpoint; the connector declares it once for every host.",
    },
    sections: [
      {
        heading: "What UCP adds to MCP",
        body: [
          "The Universal Commerce Protocol (ucp.dev) is an open specification for agentic commerce. A business publishes a profile at /.well-known/ucp that lists its services and capabilities (catalog search and lookup, checkout, fulfillment, discounts, orders) and the transports it offers them over: REST, MCP, A2A or an embedded protocol. Platforms read the profile, negotiate the capability intersection, and call the business.",
          "The MCP binding is ordinary MCP. Operations are tools invoked with tools/call; the platform's agent profile URL travels in params.arguments.meta[\"ucp-agent\"].profile; the UCP payload comes back in structuredContent, and tool definitions declare outputSchema against the UCP JSON Schemas. Nothing in the transport layer is new, which is the point: any MCP host can talk to a UCP server today.",
        ],
      },
      {
        heading: "What Shopify shipped, and how it is distributed",
        body: [
          "Shopify publishes UCP-compliant MCP servers for its Global Catalog (catalog.shopify.com), for each storefront's catalog, and for carts, checkout and orders. On 2026-09-06 the Global Catalog endpoint at https://catalog.shopify.com/api/ucp/mcp answered initialize and tools/list without authentication, reporting itself as universal-ucp-mcp and exposing search_catalog and lookup_catalog, and https://catalog.shopify.com/.well-known/ucp declared that endpoint under the mcp transport.",
          "Shopify's quickstart for developers installs a UCP CLI plus a Shopify AI Toolkit plugin, with a separate install command for each supported AI tool: Claude Code, Codex, Antigravity CLI, Cursor and VS Code. That is five hand-maintained instructions for five hosts, and every other UCP publisher inherits the same matrix the day they ship.",
        ],
      },
      {
        heading: "The same server as an agent-connector package",
        body: [
          "agent-connector is the publisher side of MCP distribution. The publisher adds @ken-jo/agent-connector to their package, declares the server once in agent-connector.config.mjs, and exposes a bin with createConnectorCli(). For a remote UCP endpoint the declaration is transport \"http\" plus the URL from the business profile. A PreToolUse hook that returns decision \"ask\" for create_checkout, update_checkout and complete_checkout makes every host that supports hooks pause before money moves.",
          "Wrapping Shopify's Global Catalog this way and running the package's install --dry-run on a machine with six agent hosts planned ten files across all six: the MCP entry plus the hook for Claude Code, Codex, Cursor and Gemini CLI, and the MCP entry alone for Windsurf and Zed, which have no hook surface. The report says which host got what and why. It also notes that per-tool token telemetry is not captured for a remote transport, because agent-connector measures tokens by wrapping a stdio server and cannot sit in front of a hosted endpoint.",
          "The developer who installs the package runs one command. agent-connector detects the hosts on that machine and writes each one's native format: mcpServers JSON for Claude Code and Cursor, TOML for Codex, settings.json for Gemini CLI and Zed, mcp_config.json for Windsurf, and so on across the 42 hosts with adapters. When a host changes its config format, the adapter changes in one place and the publisher's package does not.",
        ],
      },
      {
        heading: "What agent-connector does not do for UCP",
        body: [
          "It does not host the business profile; that lives on the business origin. It does not implement payments (AP2), identity linking or order webhooks; those belong to the UCP server and the platform. It does not carry the REST, A2A or embedded transports, because agent hosts consume MCP. It installs the MCP server, and it reports honestly which surfaces each host received.",
        ],
      },
      {
        heading: "Where to start",
        body: [
          "The step-by-step version, with the package.json, the connector declaration, the hook, the dry-run output and the two JSON-RPC calls that verify a UCP endpoint, is the guide at https://agent-connector.ai/docs/guides/ucp-mcp-server. The general publisher guide is https://agent-connector.ai/docs/guides/publish-mcp-server, and the agent-readable reference is https://agent-connector.ai/llms.txt.",
        ],
      },
    ],
  },
];

export const blogPostBySlug: Record<string, BlogPost> = Object.fromEntries(
  blogPosts.map((post) => [post.slug, post]),
);
