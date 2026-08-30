import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatCompletionBlock } from "../src/format.ts";
import {
	currentSubagentDepth,
	extractToolErrorText,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	isModelLevelFailure,
	isRetryableStartupFailure,
	pruneResultArtifacts,
	RESULT_ARTIFACT_MAX_AGE_MS,
	RESULT_ARTIFACT_MAX_FILES_PER_PROJECT,
	RESULT_LINE_MAX,
	sweepProjectResultArtifacts,
	truncateResultOutput,
	writeChildRetryPolicyExtension,
	getProjectRoot,
	writeResultArtifact,
	type SingleResult,
} from "../src/spawn.ts";

let savedTemp: string | undefined;
let savedTmp: string | undefined;
let isolatedTemp: string;

beforeAll(() => {
	savedTemp = process.env.TEMP;
	savedTmp = process.env.TMP;
	isolatedTemp = mkdtempSync(join(tmpdir(), "pi-subagents-spawn-suite-"));
	process.env.TEMP = isolatedTemp;
	process.env.TMP = isolatedTemp;
});

afterAll(() => {
	if (savedTemp === undefined) delete process.env.TEMP;
	else process.env.TEMP = savedTemp;
	if (savedTmp === undefined) delete process.env.TMP;
	else process.env.TMP = savedTmp;
	rmSync(isolatedTemp, { recursive: true, force: true });
});

function assistant(text: string): any {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function result(overrides: Partial<SingleResult>): SingleResult {
	return {
		agent: "worker",
		task: "t",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

/** Every run gets an isolated throwaway session root; nothing lands in the
 * real per-project tree during tests. */
function sessionRootForTests(): string {
	return mkdtempSync(join(tmpdir(), "pi-subagents-test-sessions-"));
}

describe("getFinalOutput", () => {
	it("returns the last assistant text part", () => {
		const messages = [assistant("first"), { role: "user", content: [] } as any, assistant("last")];
		expect(getFinalOutput(messages)).toBe("last");
	});
	it("returns empty string when there is no assistant text", () => {
		expect(getFinalOutput([{ role: "user", content: [] } as any])).toBe("");
	});
});

describe("isFailedResult", () => {
	it("fails on non-zero exit code", () => {
		expect(isFailedResult(result({ exitCode: 1 }))).toBe(true);
	});
	it("fails on error/aborted stop reason", () => {
		expect(isFailedResult(result({ stopReason: "error" }))).toBe(true);
		expect(isFailedResult(result({ stopReason: "aborted" }))).toBe(true);
	});
	it("passes on clean exit", () => {
		expect(isFailedResult(result({ exitCode: 0, stopReason: "end" }))).toBe(false);
	});
});

describe("currentSubagentDepth", () => {
	it("parses a positive integer", () => {
		expect(currentSubagentDepth({ PI_SUBAGENT_DEPTH: "3" })).toBe(3);
	});
	it("ignores garbage", () => {
		expect(currentSubagentDepth({ PI_SUBAGENT_DEPTH: "abc" })).toBe(0);
	});
});

describe("child retry policy", () => {
	it("uses a Pi extension provider adapter that forces maxRetries=0", async () => {
		const policy = await writeChildRetryPolicyExtension("test-provider/selected");
		const sourceId = `pi-subagents-test-${Date.now()}`;
		try {
			const source = readFileSync(policy.filePath, "utf8");
			expect(source).not.toContain("SettingsManager");
			expect(source).not.toContain("NODE_OPTIONS");
			const loadablePath = join(policy.dir, "loadable-policy.mjs");
			writeFileSync(
				loadablePath,
				source.replace(
					'"@earendil-works/pi-ai/compat"',
					JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/compat")),
				),
				"utf8",
			);
			registerApiProvider({
				api: "pi-subagents-test-api" as any,
				stream: (() => undefined) as any,
				streamSimple: ((_model: unknown, _context: unknown, options: unknown) => options) as any,
			}, sourceId);
			const extension = (await import(`${pathToFileURL(loadablePath).href}?${Date.now()}`)).default;
			let registration: { provider: string; config: any } | undefined;
			let beforeProviderRequest: ((event: unknown, ctx: any) => void) | undefined;
			extension({
				registerProvider(provider: string, config: any) {
					registration = { provider, config };
				},
				on(event: string, handler: (event: unknown, ctx: any) => void) {
					if (event === "before_provider_request") beforeProviderRequest = handler;
				},
			});
			expect(registration).toBeUndefined();
			beforeProviderRequest?.({}, { model: { provider: "test-provider" } });
			expect(registration?.provider).toBe("test-provider");
			const options = registration?.config.streamSimple(
				{ api: "pi-subagents-test-api" },
				{},
				{ maxRetries: 9, marker: true },
			);
			expect(options).toEqual({ maxRetries: 0, marker: true });
		} finally {
			unregisterApiProviders(sourceId);
			rmSync(policy.dir, { recursive: true, force: true });
		}
	});
});


describe("isModelLevelFailure", () => {
	it("fails when the provider rejected the run before any text was produced", () => {
		const failed = result({
			exitCode: 1,
			stopReason: "error",
			messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit" } as any],
		});
		expect(isModelLevelFailure(failed)).toBe(true);
	});

	it("uses the final assistant error even after earlier text and failed tools", () => {
		const failed = result({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "503 Service Unavailable",
			messages: [
				{ ...assistant("I inspected the repository."), stopReason: "toolUse" },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: "503 Service Unavailable" } as any,
			],
			failedTools: [{ toolName: "bash", error: "an earlier test command failed" }],
		});
		expect(getFinalOutput(failed.messages)).toBe("I inspected the repository.");
		expect(isModelLevelFailure(failed)).toBe(true);
	});

	it("is false for clean runs", () => {
		expect(isModelLevelFailure(result({ exitCode: 0, stopReason: "end" }))).toBe(false);
	});

	it("is false when a task failure ends with a non-error assistant stop", () => {
		expect(
			isModelLevelFailure(result({
				exitCode: 1,
				stopReason: "error",
				messages: [{ ...assistant("build failed"), stopReason: "stop" }],
			})),
		).toBe(false);
	});

	it("is true when a terminal provider error preserves partial text", () => {
		expect(
			isModelLevelFailure(result({
				exitCode: 1,
				stopReason: "error",
				messages: [{ ...assistant("partial response"), stopReason: "error", errorMessage: "stream terminated" } as any],
			})),
		).toBe(true);
	});

	it("is false for aborts", () => {
		expect(isModelLevelFailure(result({ exitCode: 1, stopReason: "aborted" }))).toBe(false);
	});

	it("is true for idle timeouts even with partial output", () => {
		expect(
			isModelLevelFailure(result({
				exitCode: 1,
				stopReason: "error",
				errorMessage: "Subagent idle timeout: no activity for 90 seconds.",
				messages: [assistant("partial work")],
			})),
		).toBe(true);
	});

	it("is true for idle timeouts with no output", () => {
		expect(
			isModelLevelFailure(result({
				exitCode: 1,
				stopReason: "error",
				errorMessage: "Subagent idle timeout: no activity for 90 seconds.",
			})),
		).toBe(true);
	});

	it("is false for an idle timeout while prompt acceptance is ambiguous", () => {
		expect(
			isModelLevelFailure(result({
				exitCode: 1,
				stopReason: "error",
				errorMessage: "Subagent idle timeout: no activity for 1 second.",
				rpcPromptDispatched: true,
			})),
		).toBe(false);
	});

	it("treats an explicit prompt rejection as safe even after dispatch", () => {
		expect(
			isModelLevelFailure(result({
				exitCode: 1,
				stopReason: "error",
				errorMessage: "model not found",
				rpcPromptDispatched: true,
				rpcPromptRejected: true,
			})),
		).toBe(true);
	});

	it("is false without any evidence of a model/provider error", () => {
		expect(isModelLevelFailure(result({ exitCode: 1 }))).toBe(false);
	});

	it("is false for results synthesized from a dispatch exception", () => {
		// A body-catch result (spawn infra, fs, delivery bugs) has empty messages
		// and a non-empty stderr, but it never came from the provider: it must not
		// be classified as a model-level failure.
		expect(
			isModelLevelFailure(
				result({
					exitCode: 1,
					stopReason: "error",
					stderr: "Failed to start the sub-agent process.",
					errorMessage: "ENOENT: spawn pi ENOENT",
					dispatchFailed: true,
				}),
			),
		).toBe(false);
	});

	it("is false for a pre-prompt crash that only wrote stderr", () => {
		expect(
			isModelLevelFailure(result({
				exitCode: 1,
				stopReason: "error",
				stderr: "jiti failed to compile an extension",
				errorMessage: "Subagent RPC process exited before settling (code=1).",
			})),
		).toBe(false);
	});

	it("is false for an RPC handshake or prompt ACK timeout", () => {
		expect(
			isModelLevelFailure(result({
				exitCode: 1,
				stopReason: "error",
				errorMessage: "Timed out waiting for RPC response to prompt.",
				rpcPromptDispatched: true,
			})),
		).toBe(false);
		expect(
			isModelLevelFailure(result({
				exitCode: 1,
				stopReason: "error",
				errorMessage: "Replacement prompt was rejected: Timed out waiting for RPC response to prompt.",
				rpcPromptAccepted: true,
			})),
		).toBe(false);
	});
});


describe("isRetryableStartupFailure (unit)", () => {
	const base = (overrides: Partial<SingleResult>): SingleResult => ({
		agent: "worker",
		task: "t",
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	});

	it("is retryable for a silent zero-activity fast exit", () => {
		expect(isRetryableStartupFailure(base({}), 120)).toBe(true);
	});

	it("is not retryable on a clean exit", () => {
		expect(isRetryableStartupFailure(base({ exitCode: 0 }), 120)).toBe(false);
	});

	it("is not retryable after a prompt was dispatched, accepted, or produced activity", () => {
		expect(isRetryableStartupFailure(base({ rpcPromptDispatched: true }), 120)).toBe(false);
		expect(isRetryableStartupFailure(base({ rpcPromptAccepted: true }), 120)).toBe(false);
		expect(isRetryableStartupFailure(base({ rpcActivity: true }), 120)).toBe(false);
	});

	it("is not retryable when stderr carries a real error", () => {
		expect(isRetryableStartupFailure(base({ stderr: "ENOENT: spawn pi" }), 120)).toBe(false);
	});

	it("is not retryable when an error message is set", () => {
		expect(isRetryableStartupFailure(base({ errorMessage: "429 rate limit" }), 120)).toBe(false);
	});

	it("is not retryable when the run produced model output", () => {
		expect(
			isRetryableStartupFailure(base({ messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] } as any] }), 120),
		).toBe(false);
	});

	it("is not retryable when usage shows the provider was reached", () => {
		expect(isRetryableStartupFailure(base({ usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } }), 120)).toBe(false);
	});

	it("is not retryable when the run outlived the startup window", () => {
		expect(isRetryableStartupFailure(base({}), 5000)).toBe(false);
	});

	it("is retryable for an RPC startup timeout even after the fast-exit window", () => {
		expect(
			isRetryableStartupFailure(base({
				errorMessage: "Timed out waiting for RPC response to get_state.",
				rpcStartupFailed: true,
			}), 30_000),
		).toBe(true);
	});
});

describe("truncateResultOutput", () => {
	it("leaves short output untouched", () => {
		const out = "line one\nline two";
		expect(truncateResultOutput(out, 80)).toEqual({ text: out, truncated: false });
	});

	it("truncates long output to the first maxLines lines", () => {
		const out = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
		const { text, truncated } = truncateResultOutput(out, 10);
		expect(truncated).toBe(true);
		expect(text.split("\n")).toHaveLength(10);
		expect(text).toContain("line 0");
		expect(text).not.toContain("line 10");
	});

	it("caps an oversized single line", () => {
		const long = "x".repeat(500);
		const { text, truncated } = truncateResultOutput(long, 80);
		expect(truncated).toBe(true);
		expect(text.length).toBeLessThanOrEqual(RESULT_LINE_MAX + 1); // + ellipsis
		expect(text.endsWith("…")).toBe(true);
	});
});

describe("extractToolErrorText", () => {
	it("keeps the last non-empty lines of a tool's error content", () => {
		expect(extractToolErrorText([{ type: "text", text: "head\n\nMSBuild.exe failed\nfatal error C3861: undeclared" }])).toBe("head\nMSBuild.exe failed\nfatal error C3861: undeclared");
		expect(extractToolErrorText([{ type: "text", text: "a\n\nb\nc" }])).toBe("a\nb\nc");
	});

	it("clips long lines to RESULT_LINE_MAX", () => {
		const long = "x".repeat(RESULT_LINE_MAX + 10);
		const out = extractToolErrorText([{ type: "text", text: long }]);
		expect(out.length).toBe(RESULT_LINE_MAX + 1); // clipped + ellipsis
		expect(out.endsWith("…")).toBe(true);
	});

	it("ignores non-text parts and non-array input", () => {
		expect(extractToolErrorText([{ type: "image", text: "no" }, { type: "text", text: "real" }])).toBe("real");
		expect(extractToolErrorText(undefined)).toBe("");
		expect(extractToolErrorText({ type: "text", text: "x" })).toBe("");
	});
});

describe("failed tool diagnostics", () => {
	it("attaches every retained diagnostic to a failed run's delivery", () => {
		const failed = result({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "provider failed",
			failedTools: Array.from({ length: 4 }, (_, index) => ({
				toolName: `tool-${index + 1}`,
				error: `error-${index + 1}`,
			})),
		});
		const formatted = formatCompletionBlock(failed, 80);
		for (let index = 1; index <= 4; index++) {
			expect(formatted).toContain(`- tool-${index}: error-${index}`);
		}
	});

	it("keeps transient failed calls out of a successful run's delivery", () => {
		const completed = result({
			exitCode: 0,
			messages: [assistant("done")],
			failedTools: [{ toolName: "grep", error: "no matches" }],
		});
		const formatted = formatCompletionBlock(completed, 80);
		expect(formatted).toContain("### [worker] completed");
		expect(formatted).not.toContain("no matches");
	});
});

describe("getResultOutput", () => {
	it("returns the final assistant text for a successful run", () => {
		const r = result({ exitCode: 0, messages: [assistant("all done")] });
		expect(getResultOutput(r)).toBe("all done");
	});

	it("returns just the error when a failed run has no partial output", () => {
		const r = result({ exitCode: 1, errorMessage: "crashed" });
		expect(getResultOutput(r)).toBe("crashed");
	});

	it("includes both error and partial output when a failed run has messages", () => {
		const r = result({
			exitCode: 1,
			errorMessage: "Subagent was aborted",
			stopReason: "aborted",
			messages: [assistant("I read src/index.ts and started editing...")],
		});
		const out = getResultOutput(r);
		expect(out).toContain("Subagent was aborted");
		expect(out).toContain("--- Partial output ---");
		expect(out).toContain("I read src/index.ts and started editing...");
	});
});

describe("writeResultArtifact", () => {
	it("persists the full output inside the project results root", () => {
		const resultsRoot = mkdtempSync(join(isolatedTemp, "results-root-"));
		const artifactPath = writeResultArtifact("full text\n", "reviewer", resultsRoot);
		expect(dirname(artifactPath)).toBe(resultsRoot);
		expect(artifactPath).toContain("reviewer");
		expect(readFileSync(artifactPath, "utf8")).toBe("full text\n");
		rmSync(resultsRoot, { recursive: true, force: true });
	});

	it("uses the caller-provided results root from formatCompletionBlock", () => {
		const resultsRoot = mkdtempSync(join(isolatedTemp, "results-root-"));
		const formatted = formatCompletionBlock(result({
			messages: [assistant("line one\nline two")],
		}), 1, { resultRoot: resultsRoot });
		const artifact = /full result: (.+)\)/.exec(formatted)?.[1];
		expect(artifact).toBeDefined();
		expect(dirname(artifact!)).toBe(resultsRoot);
		rmSync(resultsRoot, { recursive: true, force: true });
	});

	it("keeps same-named projects in separate project roots", () => {
		const parent = mkdtempSync(join(isolatedTemp, "pi-subagents-project-keys-"));
		const first = join(parent, "one", "same-name");
		const second = join(parent, "two", "same-name");
		mkdirSync(first, { recursive: true });
		mkdirSync(second, { recursive: true });
		expect(getProjectRoot("C:/agent/settings.json", first)).not.toBe(getProjectRoot("C:/agent/settings.json", second));
		rmSync(parent, { recursive: true, force: true });
	});

	it("bounds Markdown artifacts by age and count without touching other files", () => {
		expect(RESULT_ARTIFACT_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1_000);
		expect(RESULT_ARTIFACT_MAX_FILES_PER_PROJECT).toBe(50);
		const results = mkdtempSync(join(isolatedTemp, "pi-subagents-artifact-prune-"));
		const now = 10_000_000;
		const writeAt = (name: string, mtimeMs: number): void => {
			const path = join(results, name);
			writeFileSync(path, name, "utf8");
			utimesSync(path, mtimeMs / 1_000, mtimeMs / 1_000);
		};
		writeAt("pi-subagent-10000000000000-aaaaaaaaaaaa-newest.md", now - 100);
		writeAt("pi-subagent-10000000000001-bbbbbbbbbbbb-second.md", now - 200);
		writeAt("pi-subagent-10000000000002-cccccccccccc-overflow.md", now - 300);
		writeAt("pi-subagent-10000000000003-dddddddddddd-expired.md", now - 2_000);
		writeAt("unknown.md", now - 2_000);
		writeAt("unrelated.txt", now - 2_000);

		pruneResultArtifacts(results, { now, maxAgeMs: 1_000, maxFilesPerProject: 2 });

		expect(readdirSync(results).sort()).toEqual([
			"pi-subagent-10000000000000-aaaaaaaaaaaa-newest.md",
			"pi-subagent-10000000000001-bbbbbbbbbbbb-second.md",
			"unknown.md",
			"unrelated.txt",
		]);
		rmSync(results, { recursive: true, force: true });
	});

	it("applies retention on every write, so an active project stays bounded", () => {
		const results = mkdtempSync(join(isolatedTemp, "pi-subagents-artifact-write-prune-"));
		const expired = join(results, "pi-subagent-10000000000000-aaaaaaaaaaaa-expired.md");
		writeFileSync(expired, "old", "utf8");
		const ancient = (Date.now() - RESULT_ARTIFACT_MAX_AGE_MS - 60_000) / 1_000;
		utimesSync(expired, ancient, ancient);

		const fresh = writeResultArtifact("new text\n", "worker", results);

		// Nothing else prunes a project that keeps producing results, so the write
		// path has to age out its own directory — and never the file it just wrote.
		expect(existsSync(expired)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		rmSync(results, { recursive: true, force: true });
	});

	it("sweeps result retention across every project root", () => {
		const durableRoot = mkdtempSync(join(isolatedTemp, "pi-subagents-artifact-sweep-"));
		const now = 10_000_000;
		const projects = ["one-aaaaaaaaaaaa", "two-bbbbbbbbbbbb"];
		for (const project of projects) {
			const results = join(durableRoot, project, "results");
			mkdirSync(results, { recursive: true });
			const path = join(results, "pi-subagent-10000000000000-cccccccccccc-expired.md");
			writeFileSync(path, "old", "utf8");
			utimesSync(path, (now - 2_000) / 1_000, (now - 2_000) / 1_000);
		}

		sweepProjectResultArtifacts(durableRoot, { now, maxAgeMs: 1_000 });

		for (const project of projects) {
			expect(readdirSync(join(durableRoot, project, "results"))).toEqual([]);
		}
		rmSync(durableRoot, { recursive: true, force: true });
	});
});
