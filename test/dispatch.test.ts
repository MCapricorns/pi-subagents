import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../src/agents.ts";
import type { SubagentsConfig } from "../src/config.ts";
import { createRuntime, type SubagentThread } from "../src/runtime.ts";
import { findDuplicateActiveDispatch, type PhaseLeaseSource } from "../src/prompt.ts";
import { createBackgroundDispatcher } from "../src/thread-lifecycle.ts";

function source(partial: Partial<PhaseLeaseSource> = {}): PhaseLeaseSource {
	return {
		id: 41,
		agentName: "scout",
		task: "Trace dispatch ownership",
		cwd: process.cwd(),
		state: "running",
		...partial,
	};
}

describe("duplicate active dispatch", () => {
	it("matches normalized task and resolved cwd across agents without fuzzy matching", () => {
		const active = [source()];
		assert.equal(
			findDuplicateActiveDispatch(active, "  Trace   dispatch\nownership  ", `${process.cwd()}/child/..`)?.id,
			41,
		);
		assert.equal(findDuplicateActiveDispatch(active, "Trace dispatch phase ownership", process.cwd()), undefined);
		assert.equal(
			findDuplicateActiveDispatch([source({ state: "completed" })], "Trace dispatch ownership", process.cwd()),
			undefined,
		);
	});

	it("treats every live, parked, and settling state as leased", () => {
		for (const state of ["queued", "resuming", "running", "interrupting", "parked"] as const) {
			assert.equal(
				findDuplicateActiveDispatch([source({ state })], "Trace dispatch ownership", process.cwd())?.id,
				41,
				state,
			);
		}
		assert.equal(
			findDuplicateActiveDispatch(
				[source({ state: "completed", lifecycleOperation: "settle" })],
				"Trace dispatch ownership",
				process.cwd(),
			)?.id,
			41,
		);
	});

	it("rejects the fresh duplicate before allocating another run", async () => {
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const pi = {
			on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
			getActiveTools: () => ["read", "write"],
			sendMessage: () => undefined,
		} as unknown as ExtensionAPI;
		const runtime = createRuntime(pi, `${process.cwd()}/.pi-test/config.json`);
		runtime.threads.set(41, source() as unknown as SubagentThread);
		const artisan: AgentConfig = {
			name: "artisan",
			description: "implementation",
			systemPrompt: "body",
			source: "builtin",
			filePath: "/agents/artisan.md",
		};
		const start = createBackgroundDispatcher({
			runtime,
			getEnvironment: () => ({
				ctx: { cwd: process.cwd() } as ExtensionContext,
				config: {} as SubagentsConfig,
				agents: [artisan],
			}),
			finishRun: () => undefined,
			makeLiveHandler: () => () => undefined,
			makeDetails: (mode, background = false) => (results) => ({ mode, background, results }),
		});

		const result = await start("artisan", " Trace   dispatch ownership ", `${process.cwd()}/child/..`);
		assert.equal(result.exitCode, 1);
		assert.match(result.errorMessage ?? "", /matches run #41 \(scout\)/u);
		assert.equal(runtime.threads.size, 1);
		assert.equal(runtime.runControllers.size, 0);
	});
});
