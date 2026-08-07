/**
 * Force prompts for handling M365 confabulations and hallucinations.
 *
 * These prompts force M365 to continue when it confabulates an inability to act,
 * hallucinates file changes, or produces remote artifacts that can't be applied locally.
 */

import { looksLikeConfabulation, looksLikeHallucinatedCompletion, looksLikeRemoteArtifactCompletion } from "@m365-copilot/core";

/**
 * Force follow-up when M365 confabulates an inability to act instead of calling a tool.
 * See the confab-retry loop in handleChatCompletion().
 */
export const CONFAB_FORCE_PROMPT =
  "The working directory and the files named in the task ARE present on a real filesystem right now. Do NOT ask me to paste anything, and do NOT say commands return no output — you have not run any command yet. Emit ONE ```bash block this turn: run `ls -la` and `cat` the relevant files. Output only the ```bash block, nothing else.";

/**
 * Force follow-up when the model CLAIMS it did a file change but ran no tool.
 */
export const HALLUCINATION_FORCE_PROMPT =
  "You have NOT actually done that — no tool ran this turn, so nothing changed on disk. Do not claim a file was created, replaced, or updated until a <tool_response> confirms it. Emit ONE ```bash block now that performs the change for real (write the file with a `cat > path <<'EOF' … EOF` heredoc), and nothing else.";

/**
 * Force the intended mutation through harness tools instead of letting a remote patch leak.
 * A Teams artifact belongs to M365's remote runtime and cannot be applied by a local agent.
 */
export const REMOTE_ARTIFACT_FORCE_PROMPT =
  "The patch or download link you produced exists only in M365's remote environment and is NOT a file in the caller's working directory. Do NOT create, download, or apply a patch, and do NOT use a Teams artifact link. Use the provided local edit/write tool directly; if needed, emit ONE ```bash block that modifies the named local file in place. Output only that single local tool call, nothing else.";

export type ForcePromptType = 'confab' | 'hallucination' | 'remote_artifact';

/**
 * Determine which force prompt (if any) should be applied based on the response text.
 */
export function getForcePrompt(text: string): { type: ForcePromptType; prompt: string } | null {
  // Check for confabulation patterns
  if (looksLikeConfabulation(text)) {
    return { type: 'confab', prompt: CONFAB_FORCE_PROMPT };
  }

  // Check for hallucinated completion patterns
  if (looksLikeHallucinatedCompletion(text)) {
    return { type: 'hallucination', prompt: HALLUCINATION_FORCE_PROMPT };
  }

  // Check for remote artifact patterns
  if (looksLikeRemoteArtifactCompletion(text)) {
    return { type: 'remote_artifact', prompt: REMOTE_ARTIFACT_FORCE_PROMPT };
  }

  return null;
}
