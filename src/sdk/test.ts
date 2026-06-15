/**
 * agent-connector/sdk/test — the offline behavioral harness barrel.
 *
 * The SHIPPED test tooling, kept on its own subpath so it never enters the
 * authoring import (`@ken-jo/agent-connector/sdk`):
 *
 *   import { explain, simulate } from "@ken-jo/agent-connector/sdk/test";
 *
 *   • `explain(connector)`  — the static per-host × per-declared-surface matrix.
 *   • `simulate(connector, …)` — drive ONE host-shaped payload through the real
 *     adapter parse→handler→format chain and report whether the host honors it.
 *
 * Both are READ-ONLY and offline: they install nothing and touch no host file.
 */

export { explain, simulate } from "./test-harness.js";

export type {
  ExplainRow,
  SimulateOptions,
  SimulateResult,
} from "./test-harness.js";
