/**
 * Sub-agent dispatch: each agent runs as an isolated `pi` child process
 * (`--mode json -p --no-session`). The agent's system prompt (the .md body) is
 * written to a temp file and passed via `--append-system-prompt` (which accepts a
 * file path). Child stdout is a JSON-lines event stream; we accumulate assistant
 * messages from `message_end` events and stream partial output back via onUpdate.
 *
 * Adapted from the official pi example `examples/extensions/subagent`.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentSource } from "./agents.ts";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
/** Thinking level requested for every sub-agent: the strongest pi offers. pi's
 * session layer clamps it adaptively to what the resolved model supports
 * (max → xhigh → high → … → off), so weaker models degrade gracefully. */
export const SUBAGENT_THINKING_LEVEL = "max";
/** Max nesting depth for sub-agent -> sub-agent spawning (recursion guard). */
export const MAX_SUBAGENT_DEPTH = 2;
export const DEPTH_ENV_VAR = "PI_SUBAGENT_DEPTH";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number; // -1 = still running
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface SubagentDetails {
	mode: "single" | "parallel";
	results: SingleResult[];
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export type SubagentLiveEvent =
	| { kind: "status"; status: "queued" | "running" | "done" | "failed" }
	| { kind: "usage"; usage: UsageStats; model?: string }
	| { kind: "tool_start"; toolName: string; args: unknown }
	| { kind: "tool_end"; toolName: string; isError: boolean }
	| { kind: "thinking" }
	| { kind: "text" };

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = join(dir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await writeFile(filePath, prompt, "utf8");
	});
	return { dir, filePath };
}

/** Resolve how to invoke the SAME pi build as the current process. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

export function currentSubagentDepth(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[DEPTH_ENV_VAR];
	const parsed = raw === undefined ? 0 : Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export interface RunSingleOptions {
	defaultCwd: string;
	agent: AgentConfig | undefined;
	agentName: string;
	task: string;
	cwd?: string;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	onLive?: (e: SubagentLiveEvent) => void;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	env?: NodeJS.ProcessEnv;
}

/** Spawn one agent as an isolated pi child process and collect its output. */
export async function runSingleAgent(options: RunSingleOptions): Promise<SingleResult> {
	const { agent, agentName, task, cwd, signal, onUpdate, onLive, makeDetails } = options;

	if (!agent) {
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}".`,
			usage: emptyUsage(),
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	// Strongest thinking by default; clamped adaptively per model by pi.
	args.push("--thinking", SUBAGENT_THINKING_LEVEL);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
	};

	const emitUpdate = (): void => {
		onUpdate?.({
			content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			details: makeDetails([currentResult]),
		});
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		// Increment depth so nested sub-agents can be guarded against runaway recursion.
		const childDepth = currentSubagentDepth(options.env) + 1;
		const childEnv: NodeJS.ProcessEnv = {
			...(options.env ?? process.env),
			[DEPTH_ENV_VAR]: String(childDepth),
		};

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? options.defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
			});
			let buffer = "";

			const processLine = (line: string): void => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				// Live event: agent started
				if (event.type === "agent_start" || event.type === "turn_start") {
					if (onLive) {
						try {
							onLive({ kind: "status", status: "running" });
						} catch { /* never throw from event handling */ }
					}
				}

				// Live event: streamed assistant reasoning / output text
				if (event.type === "message_update") {
					const t = event.assistantMessageEvent?.type;
					if (t === "thinking_delta" || t === "text_delta") {
						if (onLive) {
							try {
								onLive({ kind: t === "thinking_delta" ? "thinking" : "text" });
							} catch { /* never throw from event handling */ }
						}
					}
				}

				// Live event: tool execution started
				if (event.type === "tool_execution_start") {
					if (onLive) {
						try {
							onLive({ kind: "tool_start", toolName: event.toolName ?? "unknown", args: event.args });
						} catch { /* never throw from event handling */ }
					}
				}

				// Live event: tool execution ended
				if (event.type === "tool_execution_end") {
					if (onLive) {
						try {
							onLive({ kind: "tool_end", toolName: event.toolName ?? "unknown", isError: Boolean(event.isError) });
						} catch { /* never throw from event handling */ }
					}
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);
					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = (msg as any).usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && (msg as any).model) currentResult.model = (msg as any).model;
						if ((msg as any).stopReason) currentResult.stopReason = (msg as any).stopReason;
						if ((msg as any).errorMessage) currentResult.errorMessage = (msg as any).errorMessage;
					}
					// Live event: usage snapshot after accumulation
					if (onLive) {
						try {
							onLive({ kind: "usage", usage: { ...currentResult.usage }, model: currentResult.model });
						} catch { /* never throw from event handling */ }
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};
			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				// Live event: final status derived from exit code / abort state.
				// code is null on signal termination (e.g. our own Esc abort), which
				// must read as failure — never as a false "done".
				if (onLive) {
					try {
						const failed =
							code !== 0 ||
							wasAborted ||
							(signal?.aborted ?? false) ||
							currentResult.stopReason === "error" ||
							currentResult.stopReason === "aborted";
						onLive({ kind: "status", status: failed ? "failed" : "done" });
					} catch { /* never throw from event handling */ }
				}
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				// Spawn itself failed; close may never fire, so finish the run here.
				if (onLive) {
					try {
						onLive({ kind: "status", status: "failed" });
					} catch { /* never throw from event handling */ }
				}
				resolve(1);
			});

			if (signal) {
				const killProc = (): void => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) {
			if (onLive) {
				try {
					onLive({ kind: "status", status: "failed" });
				} catch { /* never throw from event handling */ }
			}
			throw new Error("Subagent was aborted");
		}
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}
