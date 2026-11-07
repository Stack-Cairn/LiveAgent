// Error codes for a chat turn the desktop app refuses because of its model or
// provider configuration. The desktop sends the code with its own message when
// it rejects a remote turn; clients that know the code show their localized
// text, older clients fall back to the desktop message.

export const MODEL_CONFIG_ERROR_CODES = [
  "model_config_missing",
  "model_config_invalid",
  "model_config_provider_missing",
  "model_config_provider_type_mismatch",
  "model_config_model_disabled",
] as const;

export type ModelConfigErrorCode = (typeof MODEL_CONFIG_ERROR_CODES)[number];

const MODEL_CONFIG_ERROR_TRANSLATION_KEYS: Record<ModelConfigErrorCode, string> = {
  model_config_missing: "chat.modelConfigRejected.missing",
  model_config_invalid: "chat.modelConfigRejected.invalid",
  model_config_provider_missing: "chat.modelConfigRejected.providerMissing",
  model_config_provider_type_mismatch: "chat.modelConfigRejected.providerTypeMismatch",
  model_config_model_disabled: "chat.modelConfigRejected.modelDisabled",
};

export function isModelConfigErrorCode(value: unknown): value is ModelConfigErrorCode {
  return (
    typeof value === "string" && (MODEL_CONFIG_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Text to show for a failed chat turn: the localized reason for a known model
 * configuration code, otherwise the message the failure carried.
 */
export function describeChatRunFailure(
  errorCode: string | null | undefined,
  message: string,
  translate: (key: string) => string,
): string {
  const code = errorCode?.trim();
  if (isModelConfigErrorCode(code)) {
    return translate(MODEL_CONFIG_ERROR_TRANSLATION_KEYS[code]);
  }
  return message;
}
