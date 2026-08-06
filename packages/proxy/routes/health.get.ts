import { buildHealthPayload } from "@m365-copilot/proxy-lib";
import { pool, reaperHealth, runReaper } from "../server-pool";

export default defineEventHandler(async () => {
  await runReaper();
  return buildHealthPayload(pool, reaperHealth());
});
