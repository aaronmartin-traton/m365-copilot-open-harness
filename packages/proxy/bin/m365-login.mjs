#!/usr/bin/env node
import { getTokenForScope, getTokenSilent, loginInteractive } from "@m365-copilot/core";

const scopeSets = [
  { name: "Microsoft 365 Copilot", scopes: undefined },
  { name: "Power Platform environment discovery", scopes: ["https://api.bap.microsoft.com/.default"] },
  { name: "Copilot Studio agent management", scopes: ["https://api.powerplatform.com/.default"] },
];

console.log("Microsoft 365 interactive login");
console.log("Your password and MFA response are entered only on Microsoft's sign-in page.\n");
for (const { name, scopes } of scopeSets) {
  const cachedToken = scopes ? await getTokenForScope(scopes) : await getTokenSilent();
  if (cachedToken) {
    console.log(`${name} already authorized.`);
    continue;
  }
  console.log(`Authorizing ${name} in your browser...`);
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await loginInteractive(scopes, (url) => console.log(`If the window is blank, paste this URL into it:\n${url}\n`));
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 2) console.error(`Authorization attempt failed; retrying: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (lastError) throw lastError;
}

console.log("\nLogin complete. Tokens were saved to the local MSAL cache.");
console.log("You can now start m365-proxy without a secrets.json file.");
