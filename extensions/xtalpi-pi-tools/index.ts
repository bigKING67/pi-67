import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  finishOutputWithError,
  finishOutputWithTurnResult,
  startOutputMessage,
} from "./output-message.ts";
import {
  API_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "./protocol.ts";
import { runProviderTurn } from "./provider-turn.ts";
import {
  loadRuntimeConfig,
  type ProviderRuntimeConfig,
  XTALPI_API_KEY_REFERENCE,
} from "./runtime-config.ts";
import { createLocalAssistantMessageEventStream } from "./stream.ts";

let runtimeConfig: ProviderRuntimeConfig | undefined;

export {
  buildChatCompletionPayload,
  resolveProviderRuntimePolicy,
  resolveMaxOutputTokens,
  resolveRequestTimeoutMs,
} from "./runtime-config.ts";
export {
  JSON_ACTION_PROTOCOL,
  JSON_ACTION_PROTOCOL_VERSION,
  jsonActionResponseFormat,
  jsonActionSystemPrompt,
  wrapAssistantHistoryAsJsonActionFinal,
} from "./json-action-protocol.ts";

function streamXtalpiPiTools(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createLocalAssistantMessageEventStream();

  void (async () => {
    const output = startOutputMessage(stream, model);

    try {
      const result = await runProviderTurn({
        model,
        context,
        ...(options ? { options } : {}),
        ...(runtimeConfig ? { runtimeConfig } : {}),
      });
      finishOutputWithTurnResult(stream, output, result);
    } catch (error) {
      finishOutputWithError(stream, output, {
        error,
        model,
        aborted: options?.signal?.aborted === true,
      });
    }
  })();

  return stream;
}

export default function xtalpiPiTools(pi: ExtensionAPI) {
  runtimeConfig = loadRuntimeConfig();

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: runtimeConfig.baseUrl,
    apiKey: runtimeConfig.apiKey || XTALPI_API_KEY_REFERENCE,
    api: API_ID,
    models: runtimeConfig.models,
    streamSimple: streamXtalpiPiTools,
  });
}
