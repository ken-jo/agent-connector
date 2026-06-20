# Security policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately via [GitHub Security Advisories](https://github.com/ken-jo/agent-connector/security/advisories/new). Include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce or a minimal proof-of-concept.
- The agent-connector version(s) affected.
- Any host platform(s) involved (e.g. `cursor`, `claude-code`).

We will acknowledge receipt within 72 hours and aim to ship a fix within 14 days for confirmed issues. We will coordinate disclosure timing with you before publishing.

## Supported versions

Only the latest release on npm (`@ken-jo/agent-connector`) receives security fixes. Older versions are unsupported.

## Telemetry and privacy

agent-connector includes optional per-tool token telemetry. Its design is local-first:

- **What is counted:** token usage counts per MCP tool call (input + output token counts). Nothing else.
- **What is never collected:** prompt text, tool inputs, tool outputs, file contents, conversation content, or any user-identifiable information.
- **Where data goes:** counts are written locally by default. Remote egress requires explicit opt-in configuration by the connector developer; no data leaves the machine without it.
- **No silent outbound connections:** the framework does not phone home, check for updates, or send telemetry to any Anthropic or third-party endpoint on its own.

If you believe a version of agent-connector is exfiltrating data contrary to the above, please report it as a vulnerability via the private channel above.
