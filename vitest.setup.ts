import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the real ~/.config/opencode-m365 paths from unit tests. The
// handler/app/streaming/responses suites drive handleChatCompletion with
// scripted throttles; without this they append real at-limit/disengaged
// events to the real throttle-telemetry.ndjson and real sessions to
// session-state.json — polluting the live-evidence trail. Traced 2026-08-10:
// every line of throttle-telemetry.ndjson was emitted by handler.test.ts
// (convIdHash = sha256("handler-conversation"), the FakeModelSession
// fixture), including lines previously mistaken for live M365 traffic.
const dir = mkdtempSync(join(tmpdir(), "m365-unit-"));
process.env.M365_THROTTLE_TELEMETRY_FILE = join(dir, "throttle-telemetry.ndjson");
process.env.M365_SESSION_STATE_FILE = join(dir, "session-state.json");
process.env.M365_BACKOFF_STATE_FILE = join(dir, "backoff-state.json");
