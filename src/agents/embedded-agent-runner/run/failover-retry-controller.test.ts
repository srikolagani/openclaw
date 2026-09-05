import { beforeEach, describe, expect, it, vi } from "vitest";
import { onAgentEvent } from "../../../infra/agent-events.js";
import { FailoverError } from "../../failover-error.js";

const mocks = vi.hoisted(() => ({
  sleepWithAbort: vi.fn(async (_ms: number, _abortSignal?: AbortSignal): Promise<void> => {}),
  warn: vi.fn((_message: string) => {}),
}));

vi.mock("../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../logger.js")>("../logger.js");
  return { ...actual, log: { ...actual.log, warn: mocks.warn } };
});

vi.mock("../../../infra/backoff.js", async () => {
  const actual = await vi.importActual<typeof import("../../../infra/backoff.js")>(
    "../../../infra/backoff.js",
  );
  return { ...actual, sleepWithAbort: mocks.sleepWithAbort };
});

import { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";

type ControllerInput = Parameters<typeof createEmbeddedRunFailoverRetryController>[0];

function createController(
  advanceAuthProfile: ControllerInput["advanceAuthProfile"],
  fallbackConfigured = false,
  abortSignal?: AbortSignal,
) {
  return createEmbeddedRunFailoverRetryController({
    runParams: {
      runId: "run:failover-retry-controller-test",
      abortSignal,
    } as ControllerInput["runParams"],
    provider: "openai",
    modelId: "gpt-5.6-luna",
    globalLane: "test",
    agentDir: "/tmp/openclaw-failover-retry-controller-test",
    fallbackConfigured,
    profileFailureStore: { version: 1, profiles: {} },
    getLastProfileId: () => "openai:p1",
    getSessionId: () => "session:failover-retry-controller-test",
    harnessOwnsTransport: () => false,
    getRuntimeAuthOwnerId: () => "embedded",
    getApiKeyInfo: () => null,
    advanceAuthProfile,
  });
}

const rateLimitContext = {
  failoverProvider: "openai",
  failoverModel: "gpt-5.6-luna",
  logFallbackDecision: vi.fn(),
};

describe("createEmbeddedRunFailoverRetryController", () => {
  beforeEach(() => {
    mocks.sleepWithAbort.mockClear();
    mocks.warn.mockClear();
    rateLimitContext.logFallbackDecision.mockClear();
  });

  it("retries rate limits for ten attempts with capped backoff and transient status", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const events: Array<Record<string, unknown>> = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "run:failover-retry-controller-test" && event.stream === "run_status") {
        events.push(event.data);
      }
    });
    try {
      const controller = createController(vi.fn(async () => false));
      controller.setTransientRetryBudget(0);
      for (let attempt = 2; attempt <= 10; attempt++) {
        await expect(controller.maybeRetryTransient({ reason: "rate_limit" })).resolves.toBe(true);
        expect(events.at(-1)).toEqual({
          phase: "retrying",
          reason: "rate_limit",
          attempt,
          maxAttempts: 10,
        });
      }
      await expect(controller.maybeRetryTransient({ reason: "rate_limit" })).resolves.toBe(false);
      expect(mocks.sleepWithAbort.mock.calls.map(([delay]) => delay)).toEqual([
        1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000,
      ]);
      expect(events).toHaveLength(9);
    } finally {
      random.mockRestore();
      stop();
    }
  });

  it("counts earlier transient failures toward the ten-attempt rate-limit ceiling", async () => {
    const controller = createController(vi.fn(async () => false));
    for (let retry = 0; retry < 3; retry++) {
      await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(true);
    }
    for (let retry = 3; retry < 9; retry++) {
      await expect(controller.maybeRetryTransient({ reason: "rate_limit" })).resolves.toBe(true);
    }
    await expect(controller.maybeRetryTransient({ reason: "rate_limit" })).resolves.toBe(false);
    await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(false);
    expect(controller.transientRetryCount).toBe(9);
    expect(mocks.sleepWithAbort).toHaveBeenCalledTimes(9);
  });

  it.each([3, 12])(
    "does not add a %i non-rate budget after exhausting rate-limit attempts",
    async (budget) => {
      const controller = createController(vi.fn(async () => false));
      controller.setTransientRetryBudget(budget);
      for (let retry = 0; retry < 9; retry++) {
        await expect(controller.maybeRetryTransient({ reason: "rate_limit" })).resolves.toBe(true);
      }
      await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(false);
      expect(controller.transientRetryCount).toBe(9);
    },
  );

  it("retains the non-rate retry window after a long rate-limit wait", async () => {
    let nowMs = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      const controller = createController(vi.fn(async () => false));
      await expect(
        controller.maybeRetryTransient({ reason: "rate_limit", retryAfterMs: 120000 }),
      ).resolves.toBe(true);
      nowMs += 120000;
      await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(false);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("honors a rate-limit retry floor beyond the non-rate-limit time window", async () => {
    const controller = createController(vi.fn(async () => false));
    await expect(
      controller.maybeRetryTransient({ reason: "rate_limit", retryAfterMs: 120000 }),
    ).resolves.toBe(true);
    expect(mocks.sleepWithAbort).toHaveBeenCalledWith(120000, undefined);
  });

  it.each([false, true])(
    "honors a floor beyond the native timer limit (abort=%s)",
    async (abort) => {
      const { sleepWithAbort } = await vi.importActual<typeof import("../../../infra/backoff.js")>(
        "../../../infra/backoff.js",
      );
      vi.useFakeTimers();
      mocks.sleepWithAbort.mockImplementation(sleepWithAbort);
      const cancellation = new AbortController();
      const dayMs = 24 * 60 * 60 * 1000;
      const retryAfterMs = 30 * dayMs;
      try {
        const controller = createController(
          vi.fn(async () => false),
          false,
          cancellation.signal,
        );
        let retried = false;
        const retry = controller
          .maybeRetryTransient({ reason: "rate_limit", retryAfterMs })
          .then((result) => {
            retried = result;
            return result;
          });
        if (abort) {
          const rejected = expect(retry).rejects.toMatchObject({ name: "AbortError" });
          await vi.advanceTimersByTimeAsync(dayMs + 1);
          cancellation.abort();
          await rejected;
          expect(controller.transientRetryCount).toBe(0);
          expect(vi.getTimerCount()).toBe(0);
        } else {
          await vi.advanceTimersByTimeAsync(retryAfterMs - 1);
          expect(retried).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          await expect(retry).resolves.toBe(true);
          expect(controller.transientRetryCount).toBe(1);
        }
      } finally {
        vi.useRealTimers();
        mocks.sleepWithAbort.mockImplementation(async () => {});
      }
    },
  );

  it("records the truncation when the window ends a budget that still has attempts", async () => {
    let nowMs = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      const controller = createController(vi.fn(async () => false));
      // A raised budget only delivers the attempts the 90s window fits; without this
      // record an operator cannot tell why the configured retries never ran.
      controller.setTransientRetryBudget(8);
      await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(true);
      nowMs += 90_000;
      await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(false);

      expect(controller.transientRetryCount).toBe(1);
      const truncationLog = mocks.warn.mock.calls.at(-1)?.[0];
      expect(truncationLog).toContain("transient retry window elapsed");
      expect(truncationLog).toContain("after 1/8 retries");
    } finally {
      dateNow.mockRestore();
    }
  });

  it("bounds transient retries across reasons and honors Retry-After", async () => {
    // The 90s budget is wall-clock from the first consult, so the mocked sleep
    // must advance the clock for the exhaustion branch to be reachable.
    let nowMs = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    mocks.sleepWithAbort.mockImplementation(async (delayMs: number) => {
      nowMs += delayMs;
    });
    try {
      const controller = createController(vi.fn(async () => false));

      await expect(
        controller.maybeRetryTransient({ reason: "server_error", retryAfterMs: 60_000 }),
      ).resolves.toBe(true);
      await expect(
        controller.maybeRetryTransient({ reason: "timeout", retryAfterMs: 30_000 }),
      ).resolves.toBe(true);
      await expect(controller.maybeRetryTransient({ reason: "overloaded" })).resolves.toBe(false);

      expect(controller.transientRetryCount).toBe(2);
      expect(mocks.sleepWithAbort).toHaveBeenCalledTimes(2);
      expect(mocks.sleepWithAbort.mock.calls[0]?.[0]).toBe(60_000);
      expect(mocks.sleepWithAbort.mock.calls[1]?.[0]).toBe(30_000);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("counts failed-request wall time against the retry budget", async () => {
    let nowMs = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      const controller = createController(vi.fn(async () => false));
      await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(true);
      // A slow provider failure burns the window even though no backoff slept.
      nowMs += 90_000;
      await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(false);
      expect(controller.transientRetryCount).toBe(1);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("keeps profile rotation separate from transient retry accounting", async () => {
    const advanceAuthProfile = vi.fn(async () => true);
    const controller = createController(advanceAuthProfile);

    await expect(controller.advanceRateLimitAuthProfile(rateLimitContext)).resolves.toBe(true);
    await expect(controller.maybeRetryTransient({ reason: "rate_limit" })).resolves.toBe(true);

    expect(advanceAuthProfile).toHaveBeenCalledTimes(1);
    expect(controller.transientRetryCount).toBe(1);
    expect(mocks.sleepWithAbort).toHaveBeenCalledTimes(1);
  });

  it("preserves the ordinary three-retry ceiling after a rate limit", async () => {
    const controller = createController(vi.fn(async () => false));

    await expect(controller.maybeRetryTransient({ reason: "rate_limit" })).resolves.toBe(true);
    await expect(controller.maybeRetryTransient({ reason: "overloaded" })).resolves.toBe(true);
    await expect(controller.maybeRetryTransient({ reason: "timeout" })).resolves.toBe(true);
    await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(false);
    expect(controller.transientRetryCount).toBe(3);
  });

  it("honors the saved provider retry budget", async () => {
    const controller = createController(vi.fn(async () => false));
    controller.setTransientRetryBudget(1);

    await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(true);
    await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(false);
    expect(controller.transientRetryCount).toBe(1);
  });

  it("uses the bounded backoff timer without emitting a user notice", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    mocks.sleepWithAbort.mockImplementation(
      (delayMs) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        }),
    );
    try {
      const controller = createController(vi.fn(async () => false));
      const retry = controller.maybeRetryTransient({ reason: "server_error" });
      await vi.advanceTimersByTimeAsync(500);
      await expect(retry).resolves.toBe(true);
      expect(mocks.sleepWithAbort).toHaveBeenCalledWith(500, undefined);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("escalates after one successful rate-limit rotation without advancing again", async () => {
    const advanceAuthProfile = vi.fn(async () => true);
    const controller = createController(advanceAuthProfile, true);

    await expect(controller.advanceRateLimitAuthProfile(rateLimitContext)).resolves.toBe(true);
    await expect(controller.advanceRateLimitAuthProfile(rateLimitContext)).rejects.toMatchObject({
      name: "FailoverError",
      reason: "rate_limit",
      status: 429,
    } satisfies Partial<FailoverError>);
    await expect(controller.advanceRateLimitAuthProfile(rateLimitContext)).rejects.toBeInstanceOf(
      FailoverError,
    );

    expect(advanceAuthProfile).toHaveBeenCalledTimes(1);
    expect(rateLimitContext.logFallbackDecision).toHaveBeenCalledTimes(2);
    expect(rateLimitContext.logFallbackDecision).toHaveBeenNthCalledWith(1, "fallback_model", {
      status: 429,
    });
  });
});
