/**
 * Constructs OpenAI-compatible `usage` objects from M365 telemetry.
 *
 * Pure function - same inputs always produce the same output.
 */
export interface UsageInput {
  throttle: { current: number; max: number } | null;
  contentOrigin?: string | null;
  messageType?: string | null;
  scores?: Record<string, number> | null;
  turnCount?: number | null;
  requestedModel?: string;
  routedModel?: string;
  tone?: string;
  /** Steering-ladder fingerprint (ticket 02); mirrored for streamed chunks. */
  steeringFingerprint?: string;
}

export function buildUsage(input: UsageInput): Record<string, unknown> {
  const {
    throttle,
    contentOrigin,
    messageType,
    scores,
    turnCount,
    requestedModel,
    routedModel,
    tone,
    steeringFingerprint,
  } = input;

  const base: Record<string, unknown> = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };

  if (requestedModel) base.x_m365_requested_model = requestedModel;
  if (routedModel) base.x_m365_routed_model = routedModel;
  if (tone) base.x_m365_tone = tone;

  if (throttle) {
    base.x_m365_conversation_messages = throttle.current;
    base.x_m365_conversation_max = throttle.max;
    base.x_m365_conversation_pct = Math.min(100, Math.round((throttle.current / throttle.max) * 100));
    base.x_m365_conversation_remaining = Math.max(0, throttle.max - throttle.current);
  }

  if (contentOrigin) base.x_m365_content_origin = contentOrigin;
  if (messageType) base.x_m365_message_type = messageType;
  if (typeof turnCount === "number") base.x_m365_turn_count = turnCount;
  if (steeringFingerprint) base.x_m365_system_fingerprint = steeringFingerprint;

  // Disengaged-classifier scores. Empirically: clean tool calls sit at
  // ~1e-13 / ~1e-8, jailbreak-shaped prompts climb to ~1e-3 / ~1e-3. The
  // `dea_violation` component is the one that actually correlates with the
  // Disengaged filter firing — surface that explicitly so clients can monitor
  // their proximity to the threshold.
  if (scores) {
    base.x_m365_classifier_scores = scores;
    if (typeof scores.dea_violation === "number") base.x_m365_dea_score = scores.dea_violation;
    if (typeof scores.BotOffense === "number") base.x_m365_offense_score = scores.BotOffense;
  }

  return base;
}
