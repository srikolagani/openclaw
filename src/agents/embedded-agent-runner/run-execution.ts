import {
  createAgentLifecycleTerminalBackstop,
  resolveAgentLifecycleTerminalMetadata,
} from "../../auto-reply/reply/agent-lifecycle-terminal.js";
import { createAssistantErrorTranscript } from "../assistant-error-transcript.js";
import { runBestEffortCallback } from "../embedded-agent-subscribe.callback.js";
import { resolveAgentRunErrorLifecycleFields } from "../run-termination.js";
import { log } from "./logger.js";
import { runPreparedEmbeddedLoop } from "./run-loop.js";
import type { PreparedEmbeddedRunInput } from "./run/execution-context.js";
import type { EmbeddedAgentRunResult } from "./types.js";

/** Runs one fully prepared embedded-agent request. */
export async function executePreparedEmbeddedRun(
  input: PreparedEmbeddedRunInput,
): Promise<EmbeddedAgentRunResult> {
  const params = input.runParams;
  const assistantErrorTranscript =
    params.assistantErrorTranscript ?? createAssistantErrorTranscript(params);
  const terminal =
    (params.deferTerminalLifecycle ?? params.deferTerminalLifecycleEnd)
      ? undefined
      : createAgentLifecycleTerminalBackstop({
          runId: params.runId,
          sessionKey: params.sessionKey,
          startedAt: input.startedAtMs,
          getLifecycleGeneration: () => input.lifecycleGeneration,
          resolveTerminationFields: (error) =>
            resolveAgentRunErrorLifecycleFields(error, params.abortSignal),
          onTerminalEvent: (event) =>
            runBestEffortCallback({
              callback: () => params.onAgentEvent?.(event),
              label: "lifecycle agent event",
              log,
            }),
        });
  try {
    let failed = true;
    let result: EmbeddedAgentRunResult;
    try {
      result = await runPreparedEmbeddedLoop({
        ...input,
        runParams: {
          ...params,
          assistantErrorTranscript,
          deferTerminalLifecycle: true,
          onAgentEvent: terminal
            ? (event) => {
                terminal.note(event);
                return params.onAgentEvent?.(event);
              }
            : params.onAgentEvent,
        },
      });
      failed = Boolean(result.meta.error) || result.meta.stopReason === "error";
    } finally {
      // Error persistence settles before the request publishes its terminal outcome.
      if (!params.assistantErrorTranscript) {
        await assistantErrorTranscript.settle(failed && !params.abortSignal?.aborted);
      }
    }
    const error = result.meta.error?.message ?? terminal?.getDeferredError();
    terminal?.emit(
      error ? "error" : "end",
      error ? new Error(error) : result,
      resolveAgentLifecycleTerminalMetadata(result.meta),
    );
    return result;
  } catch (error) {
    terminal?.emit("error", error);
    throw error;
  }
}
