import { defineConfig } from "vitest/config";

// The suites that drive real child processes (git, node RPC children) can
// exceed vitest's 5s default when the whole suite runs in parallel on a busy
// machine; a hung test still fails at the ceiling, it just gets headroom.
export default defineConfig({
	test: {
		testTimeout: 15_000,
	},
});
