import { describe, expect, it, vi } from "vitest";
import { CONTROL_QUIESCE_TIMEOUT_MS, quiesced } from "../src/thread-lifecycle.ts";

describe("quiesced", () => {
	it("resolves true once the promise settles, for success and rejection", async () => {
		expect(await quiesced(Promise.resolve("value"))).toBe(true);
		expect(await quiesced(Promise.reject(new Error("boom")))).toBe(true);
	});

	it("resolves false after the bounded deadline instead of waiting forever", async () => {
		vi.useFakeTimers();
		try {
			const never = quiesced(new Promise<never>(() => {}), 50);
			const outcome = vi.fn();
			never.then(outcome);
			await vi.advanceTimersByTimeAsync(49);
			expect(outcome).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(2);
			expect(await never).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses the shared control deadline by default", () => {
		expect(CONTROL_QUIESCE_TIMEOUT_MS).toBeGreaterThan(0);
	});
});
