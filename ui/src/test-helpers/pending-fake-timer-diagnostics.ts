import { createHash } from "node:crypto";

export function reportPendingFakeTimers(
  baselineCount: number,
  context:
    | { scope: "control-ui-proof"; stage: string; late: string }
    | { scope: "sidebar-narration"; assertion: string; expectedCount: number },
): void {
  try {
    // Vitest 5's Sinon clock is exposed on installed timer functions. Read it only
    // after the assertion fails; never clear, wrap, or advance unrelated timers.
    const clock = (
      globalThis.setTimeout as typeof setTimeout & {
        clock?: {
          now?: number;
          jobs?: unknown[];
          timers?: Map<
            number,
            {
              id?: number;
              type?: string;
              delay?: number;
              createdAt?: number;
              callAt?: number;
              interval?: number;
              func?: unknown;
            }
          >;
        };
      }
    ).clock;
    const finite = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    const timers = [];
    for (const timer of clock?.timers?.values() ?? []) {
      if (timers.length === 8) {
        break;
      }
      const callback = typeof timer.func === "function" ? timer.func : undefined;
      const source = callback ? Function.prototype.toString.call(callback) : "";
      timers.push({
        id: finite(timer.id),
        type: ["Timeout", "Interval", "Immediate", "AnimationFrame", "IdleCallback"].includes(
          timer.type ?? "",
        )
          ? timer.type
          : "unknown",
        delay: finite(timer.delay),
        createdAt: finite(timer.createdAt),
        callAt: finite(timer.callAt),
        interval: finite(timer.interval),
        callbackName: callback?.name.replace(/[^a-zA-Z0-9_$]/g, "").slice(0, 64) ?? null,
        callbackSha256: callback ? createHash("sha256").update(source).digest("hex") : null,
        // Static source markers are hints, not owner proof. Do not log source,
        // callback arguments, captured values, or arbitrary timer properties.
        markers: (
          [
            ["fs-safe-timeout", "reject(createError())"],
            ["exporter-flush", "writer.flush()"],
            ["request-attempt", "attemptController"],
            ["request-backpressure", "backpressureWaiters"],
            ["request-retry", "attemptIndex"],
            ["sidebar-retry", "retry.retryAt"],
            ["sidebar-retry-sync", "this.sync(this.input)"],
            ["sidebar-throttle", "throttle.pending"],
          ] as const
        )
          .filter(([, marker]) => source.includes(marker))
          .map(([name]) => name),
      });
    }
    const prefix =
      context.scope === "control-ui-proof"
        ? "control-ui-proof-pending-timers"
        : "sidebar-narration-pending-timers";
    process.stderr.write(
      `[${prefix}] ${JSON.stringify({
        ...context,
        baselineCount,
        now: finite(clock?.now),
        clockAvailable: Boolean(clock),
        pendingJobs: clock?.jobs?.length ?? 0,
        pendingTimers: clock?.timers?.size ?? 0,
        timers,
      })}\n`,
    );
  } catch {
    // Diagnostic failures must never replace the original timer assertion.
  }
}
