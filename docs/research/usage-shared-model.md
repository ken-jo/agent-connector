I have enough information now. Let me compile the comprehensive Markdown brief:

---

# Tokscale SHARED Model — TypeScript Port Brief

## Overview

Tokscale is a normalized token usage tracking system for LLM interactions across multiple AI coding assistants. The system ingests session logs from platforms (Claude, OpenCode, Codex, Cursor, etc.), deduplicates them, aggregates by time/session/model, and reports cost via a pluggable pricing service. This brief documents the canonical data structures and normalization strategies to ground a TypeScript port.

---

## 1. Canonical Normalized Usage Record: `UnifiedMessage`

All session logs are parsed into a single **unified message format** that normalizes heterogeneous provider representations:

### Core Fields

```
struct UnifiedMessage {
  // Identity
  client: String,                  // e.g. "opencode", "claude", "codex", "cursor"
  model_id: String,               // Raw model identifier (later normalized for grouping)
  provider_id: String,            // e.g. "anthropic", "openai", "google"
  session_id: String,             // Session identifier; prevents cross-session double-counting

  // Token Breakdown (the heart of usage tracking)
  tokens: TokenBreakdown {
    input: i64,                   // Prompt/input tokens
    output: i64,                  // Completion/output tokens
    cache_read: i64,              // Tokens read from cache (semantic/prompt caching)
    cache_write: i64,             // Tokens written to cache (cache creation)
    reasoning: i64,               // Extended thinking / o1-style reasoning tokens
  },

  // Derived Fields
  cost: f64,                       // USD; populated by pricing service or extracted from log
  timestamp: i64,                 // Unix milliseconds
  date: String,                   // YYYY-MM-DD (derived from timestamp + local timezone)
  duration_ms: Option<i64>,       // End-to-end message duration (optional, for perf metrics)
  message_count: i32,             // Number of turns/messages in this record (default 1)

  // Optional Metadata
  workspace_key: Option<String>,  // Git repo path or project key (normalized)
  workspace_label: Option<String>,// Human-readable workspace name (last path segment)
  agent: Option<String>,          // AI agent name (e.g. "Sisyphus", "Prometheus")
  dedup_key: Option<String>,      // Unique ID for cross-source deduplication
  is_turn_start: bool,            // First assistant response after user turn (for turn counting)
}
```

### TokenBreakdown Utility

```
impl TokenBreakdown {
  fn total(&self) -> i64 {
    input + output + cache_read + cache_write + reasoning
  }
}
```

**Why this shape:**
- Multi-provider pricing tiers vary by token type (input vs. output, cached reads charge fractionally).
- Session IDs prevent double-counting when the same conversation appears in multiple client logs.
- `dedup_key` handles overlaps: OpenCode SQLite (current) vs. JSON (legacy), Codex channel-suffixed dbs.
- `date` field is precomputed for efficient daily aggregation without re-parsing timestamps.

---

## 2. Storage Roots: Platform-Specific Log Locations

Tokscale scans client-specific filesystem roots to discover session log files. Roots are **resolved per platform with environment variable overrides**:

### Root Resolution Strategy (for each client)

Each client (Claude, OpenCode, Codex, etc.) has a **canonical storage root** determined by:

1. **Environment override** (if set and non-empty): take verbatim
2. **Platform-specific default**:
   - Claude: `~/.config/claude/sessions.json` (session metadata) + `~/.cache/claude/` (indexed logs)
   - OpenCode: `~/.config/opencode/` or `~/.cursor/opencode/` (SQLite or JSON)
   - Codex: `~/.config/codex/` + headless roots (CI/headless agent logs)
   - Cursor: `~/.cursor/extensions/cursor-vscode/logs/` + workspace-specific roots

### Global Config & Cache Directories

**`paths.rs` — canonical path resolver:**

```
fn get_config_dir() -> PathBuf {
  // 1. TOKSCALE_CONFIG_DIR environment override (if set and non-empty)
  if let Some(custom) = std::env::var_os("TOKSCALE_CONFIG_DIR") {
    if !custom.is_empty() { return PathBuf::from(custom); }
  }

  // 2. macOS: $HOME/.config/tokscale (overrides ~/Library/Application Support/)
  #[cfg(target_os = "macos")]
  if let Some(home) = dirs::home_dir() {
    return home.join(".config").join("tokscale");
  }

  // 3. Linux: XDG_CONFIG_HOME/tokscale or $HOME/.config/tokscale
  // 4. Windows: dirs::config_dir()/tokscale
  // 5. Fallback: ./.tokscale
}

fn get_cache_dir() -> PathBuf {
  get_config_dir().join("cache")
}
```

**Resolved Locations (Linux/macOS with no overrides):**

| File/Directory | Path |
|---|---|
| Config root | `~/.config/tokscale/` |
| Cache root | `~/.config/tokscale/cache/` |
| Settings JSON | `~/.config/tokscale/settings.json` |
| Message cache | `~/.config/tokscale/cache/source-message-cache.bincode` |
| Pricing cache | `~/.config/tokscale/cache/pricing.json` |
| TUI data cache | `~/.config/tokscale/cache/tui-data-cache.json` |

**Key Design Principle:**
- `TOKSCALE_CONFIG_DIR` environment variable applies to **all** state uniformly (hermetic isolation for CI/tests).
- Empty string is treated as "unset" to prevent accidental `./` writes.
- Legacy migration probes `~/.cache/tokscale/` and `~/Library/Caches/tokscale/` only when the override is absent.

---

## 3. Model Normalization & Provider/Family Identity Mapping

### Model ID Normalization (for grouping)

Raw model IDs from APIs and logs are normalized before aggregation:

```
fn normalize_model_for_grouping(model_id: &str) -> String {
  let mut name = model_id.to_lowercase();

  // Step 1: Strip thinking effort suffix
  // "claude-3-5-sonnet(medium)" → "claude-3-5-sonnet"
  if let Some(base_model) = strip_parenthesized_reasoning_tier(&name) {
    name = base_model.to_string();
  }

  // Step 2: Strip date suffixes (e.g., "-20250101")
  if name.len() > 9 && name[name.len() - 8..].chars().all(|c| c.is_ascii_digit()) {
    name = name[..name.len() - 9].to_string();
  }

  // Step 3: Normalize dots in version numbers (Claude only)
  // "claude-3.5-sonnet" → "claude-3-5-sonnet"
  if name.contains("claude") {
    // Replace dots between digits with dashes
    name = replace_version_dots(&name);
  }

  // Step 4: Normalize "anthropic/claude-" prefixes
  // "anthropic/claude-3-opus-20240229" → "claude-3-opus"
  if let Some(canonical) = normalize_anthropic_prefixed_claude_model(&name) {
    name = canonical;
  }

  name
}

fn strip_parenthesized_reasoning_tier(model_id: &str) -> Option<&str> {
  let without_closing = model_id.strip_suffix(')')?;
  let (base, tier) = without_closing.rsplit_once('(')?;
  if matches!(tier, "minimal" | "low" | "medium" | "high" | "xhigh" | "auto" | "none") {
    Some(base)
  } else {
    None
  }
}

fn normalize_anthropic_prefixed_claude_model(model_id: &str) -> Option<String> {
  let rest = model_id.strip_prefix("anthropic/claude-")?;
  let mut parts = rest.split('-');
  let major = parts.next()?;      // e.g., "3"
  let minor = parts.next()?;      // e.g., "5"
  let family = parts.next()?;     // "opus", "sonnet", "haiku"
  if parts.next().is_some() {
    return None;  // Too many parts
  }
  if !matches!(family, "opus" | "sonnet" | "haiku") {
    return None;
  }
  Some(format!("claude-{}-{}-{}", family, major, minor))
}
```

**Examples:**
- `claude-3-5-sonnet-20250514` → `claude-3-5-sonnet`
- `claude-3.5-sonnet(medium)` → `claude-3-5-sonnet`
- `anthropic/claude-3-opus-20240229` → `claude-3-opus`
- `gpt-4o-2024-08-06` → `gpt-4o`
- `claude-haiku(low)` → `claude-haiku`

### Provider/Model Identity (`provider_identity.rs`)

Maps raw model IDs and provider strings to canonical provider families:

```
pub fn inferred_provider_from_model(model: &str) -> Option<&'static str> {
  let lower = model.to_lowercase();

  if lower.contains("claude") || lower.contains("anthropic") ||
     contains_delimited(&lower, "opus|sonnet|haiku") {
    return Some("anthropic");
  }
  if lower.contains("gpt") || lower.contains("openai") ||
     contains_delimited(&lower, "o1|o3|o4") {
    return Some("openai");
  }
  if lower.contains("gemini") || lower.contains("google") {
    return Some("google");
  }
  if lower.contains("grok") { return Some("xai"); }
  if lower.contains("deepseek") { return Some("deepseek"); }
  if lower.contains("mistral") || lower.contains("mixtral") {
    return Some("mistralai");
  }
  if lower.contains("llama") { return Some("meta"); }
  if lower.contains("qwen") { return Some("qwen"); }
  None
}

pub fn canonical_provider(raw: &str) -> Option<String> {
  provider_tags(raw).into_iter().next()
}

pub fn provider_tags(raw: &str) -> Vec<String> {
  // Normalize aliases: "openai-codex" → ["openai"], "vertex_ai" → ["anthropic"]
  // Extract nested providers: "openrouter/google" → ["openrouter", "google"]
}
```

**Canonical Provider Mappings:**
| Raw Provider | Canonical |
|---|---|
| `openai`, `openai-codex`, `openai_codex` | `openai` |
| `anthropic`, `vertex`, `vertex_ai` | `anthropic` |
| `google`, `gemini` | `google` |
| `mistral`, `mistralai` | `mistralai` |
| `fireworks`, `fireworks_ai` | `fireworks_ai` |
| `meta`, `meta_llama` | `meta_llama` |

---

## 4. Aggregation by Grouping Dimensions

### Aggregation Hierarchy

Messages are aggregated into two primary structures:

#### Daily Aggregation (`aggregate_by_date`)

Groups messages by `date` (YYYY-MM-DD), computing totals and per-client breakdowns:

```
pub struct DailyContribution {
  pub date: String,
  pub totals: DailyTotals {
    tokens: i64,                // sum of all token.total()
    cost: f64,
    messages: i32,
  },
  pub intensity: u8,            // 0-4 (visual intensity based on % of max daily cost)
  pub token_breakdown: TokenBreakdown,
  pub clients: Vec<ClientContribution> {  // Per-(client, model) breakdown
    client: String,
    model_id: String,           // Normalized
    provider_id: String,
    tokens: TokenBreakdown,
    cost: f64,
    messages: i32,
  },
  pub active_time_ms: Option<i64>,  // Active time for the day (computed separately)
}
```

**Grouping Key:** `(date)`  
**Inner Grouping:** `(client, normalized_model_id)`

#### Session Aggregation (`aggregate_by_session`)

Groups messages by `session_id`, tracking first/last timestamps and top-contributing client:

```
pub struct SessionContribution {
  pub session_id: String,
  pub client: String,           // Highest-cost client in session
  pub provider: String,
  pub model: String,
  pub totals: DailyTotals,
  pub token_breakdown: TokenBreakdown,
  pub clients: Vec<ClientContribution>,  // All clients in session
  pub first_seen: i64,          // Earliest timestamp (seconds, not ms)
  pub last_seen: i64,           // Latest timestamp (seconds, not ms)
}
```

**Grouping Key:** `(session_id)`  
**Tie-breaking:** Sessions sorted by `last_seen` descending (most recent first)

### GroupBy Modes (Report-level Aggregation)

For reporting, messages can be grouped at various levels:

```
enum GroupBy {
  Model,                     // Group only by model (merge all clients)
  ClientModel,               // Group by (client, model)  [DEFAULT]
  ClientProviderModel,       // Group by (client, provider, model)
  WorkspaceModel,            // Group by (workspace, model)
  Session,                   // Group by (session, model)
  ClientSession,             // Group by (client, session, model)
}
```

**Semantics:**
- `Model`: Total usage per model across all clients/providers.
- `ClientModel`: Per-client breakdown at model level.
- `ClientProviderModel`: Finest granularity (disambiguates proxy gateways).
- `WorkspaceModel`: Per-git-repo usage.
- `Session`: Per-interactive-session (agent-CLI or IDE session).
- `ClientSession`: Both client and session granularity.

---

## 5. Deduplication & Sessionization Strategy

### Cross-Source Deduplication

Multiple clients may ingest the same API call (via shared API keys, log mirrors, or channel switches). **Deduplication prevents double-counting:**

#### Strategy by Client

| Client | Dedup Method | Key |
|---|---|---|
| **OpenCode** | Prefer SQLite, suppress JSON overlap | `dedup_key` (message hash) |
| **Claude** | Message fingerprinting + `dedup_key` | Hash of (timestamp, tokens, cost) |
| **Codex** | Dedup across multiple logs | Message body + timestamp |
| **Trae** | Latest-per-session (API aggregates deltas) | `session_id` + timestamp ordering |
| **Hermes** | Cross-database dedup | Message identity keys |

**Global Dedup Pattern:**
```
let mut seen_keys: HashSet<String> = HashSet::new();

for message in messages {
  if let Some(dedup_key) = &message.dedup_key {
    if seen_keys.insert(dedup_key.clone()) {
      // First time seeing this key → include
      filtered.push(message);
    }
    // Duplicate → skip
  } else {
    // No dedup key → always include (deterministic ordering ensures consistency)
    filtered.push(message);
  }
}
```

### Session Intervals & Time Metrics

**Sessionization** derives continuous activity windows from the message stream, used to compute active time (excluding idle gaps):

```
pub struct SessionInterval {
  pub client: String,
  pub session_id: String,
  pub start_ts: i64,           // First message timestamp (ms)
  pub end_ts: i64,             // Last message timestamp (ms)
  pub wall_duration_ms: i64,   // end_ts - start_ts
  pub active_duration_ms: i64, // Wall time minus gaps > idle_gap_ms
  pub message_count: i32,
  pub tokens: TokenBreakdown,
  pub cost: f64,
}

pub const DEFAULT_IDLE_GAP_MS: i64 = 3 * 60 * 1000;  // 3 minutes
```

**Algorithm:**
1. Group messages by `(client, session_id)`.
2. Sort each group by timestamp.
3. For each consecutive pair of messages, compute gap = `t2 - t1`.
4. If `gap <= idle_gap_ms`, include it in `active_duration_ms`.
5. If `gap > idle_gap_ms`, exclude (user was idle).

**Derived Metrics:**
```
pub struct TimeMetrics {
  pub total_active_time_ms: i64,        // Sum of all session active_duration_ms
  pub total_wall_time_ms: i64,          // Sum of all session wall_duration_ms
  pub longest_continuous_ms: i64,       // Max merged activity window (using idle_gap_ms tolerance)
  pub max_concurrent_sessions: u32,     // Peak overlapping sessions (sweep-line algorithm)
  pub session_count: u32,
}
```

**Daily Active Time Computation:**
- For each session interval, distribute its `active_duration_ms` proportionally across local-date boundaries.
- Single-day sessions: full active time on that day.
- Multi-day sessions: split by wall-clock overlap per day.

---

## 6. Pricing Model

Pricing is resolved from a JSON service and cached locally. The system supports **multiple providers with per-token-type rates**:

### Pricing Lookup Pattern

```
pub struct PricingService {
  // Maps (provider, model) → PricingInfo
  prices: HashMap<String, PricingInfo>,
}

pub struct PricingInfo {
  pub input_usd_per_mtok: f64,       // Per million input tokens
  pub output_usd_per_mtok: f64,      // Per million output tokens
  pub cache_read_usd_per_mtok: f64,  // Per million cached-read tokens (typically ~10% of input)
  pub cache_write_usd_per_mtok: f64, // Per million cache-write tokens (typically ~25% of input)
  pub reasoning_usd_per_mtok: f64,   // Per million reasoning tokens (if applicable)
}

fn compute_cost(breakdown: &TokenBreakdown, pricing: &PricingInfo) -> f64 {
  let input_cost = (breakdown.input as f64 / 1_000_000.0) * pricing.input_usd_per_mtok;
  let output_cost = (breakdown.output as f64 / 1_000_000.0) * pricing.output_usd_per_mtok;
  let cache_read_cost = (breakdown.cache_read as f64 / 1_000_000.0) * pricing.cache_read_usd_per_mtok;
  let cache_write_cost = (breakdown.cache_write as f64 / 1_000_000.0) * pricing.cache_write_usd_per_mtok;
  let reasoning_cost = (breakdown.reasoning as f64 / 1_000_000.0) * pricing.reasoning_usd_per_mtok;

  input_cost + output_cost + cache_read_cost + cache_write_cost + reasoning_cost
}
```

### Cost Application Flow

1. **Parse all messages** from all client sources (with or without cost data).
2. **Load pricing service** from cache (`~/.config/tokscale/cache/pricing.json`) or fetch if stale.
3. **Apply pricing** to messages missing cost (most platforms don't include cost in logs).
4. **Cache messages** with refreshed cost (incremental).

**Cost Caching:**
- Source fingerprint-based caching: if file content (by hash+size) is unchanged, reuse cached parsed messages.
- Pricing is baked into cached messages so pricing updates invalidate the cache.

---

## 7. Summary of Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. SCAN: Discover logs per client (OpenCode, Claude, Codex, ...) │
│    Respects TOKSCALE_CONFIG_DIR override + platform defaults      │
└────────────────────┬────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ 2. PARSE: Convert each client log to UnifiedMessage             │
│    - Model ID normalized (strip reasoning tiers, dates, etc.)   │
│    - Provider inferred from model or explicit in log             │
│    - Timestamp & date computed (local tz-aware)                  │
│    - Tokens: input, output, cache_read, cache_write, reasoning  │
└────────────────────┬────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ 3. DEDUPLICATE: Suppress cross-source overlaps                  │
│    - Keep first by dedup_key (deterministic per client)         │
│    - Preserve deterministic ordering for reproducibility         │
└────────────────────┬────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ 4. APPLY PRICING: Fill in cost for messages missing it          │
│    - Load pricing from cache or fetch if stale                  │
│    - Compute cost from tokens × per-token-type rates            │
│    - Cache updated messages                                     │
└────────────────────┬────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ 5. FILTER & GROUP: Apply date/client/model filters              │
│    - Filter by date range (--since, --until, --year)             │
│    - Filter by client list (--clients)                           │
└────────────────────┬────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ 6. AGGREGATE: Group by time/session/model per GroupBy mode     │
│    - Daily: parallel fold/reduce on date                        │
│    - Session: parallel fold/reduce on session_id                │
│    - Compute per-client breakdowns, intensities, metrics         │
└────────────────────┬────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ 7. COMPUTE METRICS: Derive time-based statistics                │
│    - Sessionize: derive continuous activity windows              │
│    - Active time: wall_duration minus idle gaps > 3min           │
│    - Concurrency: peak overlapping sessions                      │
└────────────────────┬────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ 8. REPORT: Serialize daily/session contributions                │
│    - GraphResult: date-sorted DailyContribution[] + meta         │
│    - ModelReport: per-model usage ranked by cost                 │
│    - HourlyReport: per-hour usage buckets                        │
└────────────────────────────────────────────────────────────────┘
```

---

## Key TS Port Considerations

1. **Timezone Handling:** Tokscale dates are always local-tz-aware. Use a library like `date-fns` or `dayjs` with timezone support for consistency.
2. **Parallel Aggregation:** Rust's Rayon enables parallel fold/reduce. TypeScript alternatives: Web Workers, or synchronous single-threaded (adequate for most use cases).
3. **Dedup Determinism:** Preserve insertion order and stable sorting for reproducible dedup and aggregation.
4. **Pricing Caching:** Implement file-based cache with fingerprinting (file hash + size) to avoid re-parsing logs on every run.
5. **Model Normalization:** The regex/string manipulations for model ID normalization are order-dependent; porting must preserve exact sequence.
6. **Provider Inference:** Multi-step heuristic (keyword matching, then provider tags, then inferred). Keep precedence rules explicit.

---

# Conclusion

The Tokscale SHARED model is fundamentally:
- **UnifiedMessage**: normalized token usage record with 5-part token breakdown and session/workspace metadata.
- **Aggregation**: parallelizable fold/reduce on date or session_id, with per-client model-level breakdowns.
- **Deduplication**: cross-source via deterministic `dedup_key` insertion-order logic.
- **Pricing**: pluggable service mapping (provider, model) to per-token-type rates in USD/MTok.
- **Time Metrics**: derived session intervals with idle-gap-aware active duration and peak concurrency.

These primitives enable portable, efficient token accounting across a fragmented ecosystem of AI coding assistants, with first-class support for cache tokens and reasoning tokens (o1/o3-style extended thinking).