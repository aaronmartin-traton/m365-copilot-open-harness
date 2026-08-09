export {
  getToken,
  getTokenSilent,
  getTokenForScope,
  getImageArtifactToken,
  loginInteractive,
  getBrowserProfileDir,
} from "./auth.js";

export {
  noteRequestOutcome,
  awaitDegradationBackoff,
  isDegradationBackoff,
  createBackoffController,
  getDegradationBackoffState,
  type BackoffController,
  type BackoffOptions,
  type BackoffState,
} from "./auth-recovery.js";

export {
  emitThrottleEvent,
  getThrottleEventCounts,
  hashConversationId,
  type ThrottleEvent,
  type ThrottleEventType,
} from "./throttle-telemetry.js";

export { getOrCreateAgent, getAgentAvailability } from "./agent.js";

export {
  decodeJwt,
  getToneForModel,
  getAvailableModels,
  type CopilotStream,
  type CapturedImage,
} from "./copilot.js";

export {
  CopilotSession,
  type CopilotSessionOptions,
  type NativeActionConfig,
  type ChatTurnOptions,
} from "./session.js";
export {
  generateImage,
  fetchImageBytes,
  buildImagePrompt,
  classifyImageFailure,
  ImageGenerationError,
  type GeneratedImage,
  type GenerateImageOptions,
  type ImageOrientation,
  type ImageStyle,
  type ImageGenFailureReason,
} from "./image.js";

export {
  parseActionConfirmation,
  buildResumeInvokeAction,
  shouldAutoConfirm,
  buildNativeActionPrompt,
  NATIVE_ACTION_INSTRUCTIONS,
  ACTION_ALLOWED_MESSAGE_TYPES,
  ACTION_CONFIRM_MESSAGE_TYPES,
  type ActionConfirmation,
} from "./native-actions.js";

export {
  ModelSession,
  type ModelSessionOptions,
} from "./model.js";

export {
  formatMessages,
  formatToolDefinitions,
  formatToolChoiceInstruction,
  getMessageContent,
  getMessageImages,
  parseToolCalls,
  looksLikeConfabulation,
  looksLikeHallucinatedCompletion,
  looksLikeRemoteArtifactCompletion,
  isProseDocument,
  type Message,
  type ToolDef,
  type ToolFunction,
  type ToolChoice,
  type ParsedToolCall,
  type ParseResult,
  type ImageContentPart,
  type TextContentPart,
} from "./tools.js";

export {
  getLocalShellBackend,
  validateLocalShellBackend,
  type LocalShellBackend,
} from "./fenced.js";

export {
  M365WebConversationClient,
  M365WebConversationError,
  M365WebSessionUnavailableError,
  type M365WebConversationClientLike,
  type M365WebConversationClientOptions,
} from "./web-conversations.js";

export {
  runCoworkProbe,
  type CoworkProbeOptions,
  type CoworkProbeResult,
} from "./cowork.js";
export { decodeSocketPacket, type CoworkSocketPacket } from "./cowork-protocol.js";

export {
  MAX_IMAGE_BYTES,
  prepareImageAttachments,
  type ImageMediaType,
  type ImageInput,
  type PreparedImageAttachment,
} from "./images.js";

export { createLogger, trunc, LOG_PATH } from "./log.js";
