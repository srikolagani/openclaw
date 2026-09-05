import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedClassifyAssistantFailoverReason,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import {
  createSharedRunIntegrationSession,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";

describe("direct embedded retry lifecycle", () => {
  let run: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
  let session: Awaited<ReturnType<typeof createSharedRunIntegrationSession>>;
  beforeAll(async () => {
    run = await loadSharedRunIntegrationHarness();
  });
  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
    mockedClassifyAssistantFailoverReason.mockReturnValue(null);
    mockedClassifyFailoverReason.mockReturnValue(null);
    session = await createSharedRunIntegrationSession();
  });
  afterEach(async () => {
    await session?.cleanup();
  });

  it.each(["recovered", "exhausted", "caller-deferred"] as const)(
    "publishes only the owning terminal after %s attempts",
    async (outcome) => {
      let attempts = 0;
      const onAgentEvent = vi.fn();
      mockedRunEmbeddedAttempt.mockImplementation(async (params) => {
        const failed = ++attempts === 1 || outcome === "exhausted";
        const assistant = makeAssistantMessageFixture({
          provider: "mock",
          model: "model",
          stopReason: failed ? "error" : "stop",
          content: failed ? [] : [{ type: "text", text: "Recovered reply" }],
          errorMessage: failed ? "provider failure" : undefined,
        });
        await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
        // Harnesses defer their attempt terminal when the logical-run owner requests it.
        await params.onAgentEvent?.({
          stream: "lifecycle",
          data: {
            phase: params.deferTerminalLifecycle ? "finishing" : failed ? "error" : "end",
            ...(failed ? { error: "provider failure" } : {}),
          },
        });
        return makeAttemptResult({
          assistantTexts: failed ? [] : ["Recovered reply"],
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
        });
      });
      await run({
        ...session.runParams,
        provider: "mock",
        model: "model",
        onAgentEvent,
        deferTerminalLifecycle: outcome === "caller-deferred",
      });
      const terminals = onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter(
          (event) => event.stream === "lifecycle" && ["end", "error"].includes(event.data.phase),
        );
      expect(attempts).toBe(outcome === "exhausted" ? 4 : 2);
      expect(terminals).toEqual(
        outcome === "caller-deferred"
          ? []
          : [
              expect.objectContaining({
                stream: "lifecycle",
                data: expect.objectContaining({
                  phase: outcome === "exhausted" ? "error" : "end",
                  executionSettled: true,
                }),
              }),
            ],
      );
    },
  );
});
