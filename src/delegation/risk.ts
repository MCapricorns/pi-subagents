import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runCommand } from "../isolation/git-command.ts";

export type SubagentRiskCategory =
	| "concurrency"
	| "trust-boundary"
	| "persistence-compatibility"
	| "failure-cancellation";

export type GitRiskRunner = (
	cwd: string,
	args: readonly string[],
	signal?: AbortSignal,
) => Promise<string>;

export interface SubagentRiskAdvisory {
	available: boolean;
	changedPaths: string[];
	categories: SubagentRiskCategory[];
	matches: Partial<Record<SubagentRiskCategory, string[]>>;
	recommendSentinel: boolean;
	unavailableReason?: string;
}

const CATEGORY_RULES: ReadonlyArray<{
	category: SubagentRiskCategory;
	pattern: RegExp;
}> = [
	{
		category: "concurrency",
		pattern: /(?:^|[/_.-])(?:concurr(?:ency|ent)?|parallel|queues?|workers?|threads?|locks?|mutex|semaphore|dispatch|background|races?|lane)(?:[/_.-]|$)/u,
	},
	{
		category: "trust-boundary",
		pattern: /(?:^|[/_.-])(?:auth|credentials?|permissions?|policy|privilege|secrets?|security|sandbox|trust|tokens?)(?:[/_.-]|$)/u,
	},
	{
		category: "persistence-compatibility",
		pattern: /(?:^|[/_.-])(?:compat(?:ibility)?|durable|manifests?|migrations?|persist(?:ence|ent)?|restore|schemas?|serializ(?:e|ation)|storage)(?:[/_.-]|$)/u,
	},
	{
		category: "failure-cancellation",
		pattern: /(?:^|[/_.-])(?:abort(?:ed|ion|s)?|cancel(?:ed|lation|led)?|errors?|fail(?:ed|ures?)?|recovery|retries|retry|stop|timeout)(?:[/_.-]|$)/u,
	},
];

function normalizedGitPath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function classifyRiskPaths(paths: readonly string[]): Pick<
	SubagentRiskAdvisory,
	"categories" | "matches" | "recommendSentinel"
> {
	const normalized = [...new Set(paths.map(normalizedGitPath).filter(Boolean))].sort();
	const matches: Partial<Record<SubagentRiskCategory, string[]>> = {};
	const categories: SubagentRiskCategory[] = [];
	for (const rule of CATEGORY_RULES) {
		const matching = normalized.filter((path) => rule.pattern.test(path.toLowerCase()));
		if (matching.length === 0) continue;
		categories.push(rule.category);
		matches[rule.category] = matching;
	}
	return { categories, matches, recommendSentinel: categories.length > 0 };
}

const RISK_GIT_TIMEOUT_MS = 30_000;
const RISK_GIT_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

const defaultGitRunner: GitRiskRunner = async (cwd, args, signal) => {
	const result = await runCommand("git", args, {
		cwd,
		signal,
		timeoutMs: RISK_GIT_TIMEOUT_MS,
		maxOutputBytes: RISK_GIT_OUTPUT_MAX_BYTES,
	});
	if (result.code !== 0) {
		const detail = result.stderr.toString("utf8").trim();
		throw new Error(detail || `git ${args[0] ?? "command"} exited with code ${result.code}`);
	}
	return result.stdout.toString("utf8");
};

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function nulPaths(output: string): string[] {
	return output.split("\0").map(normalizedGitPath).filter(Boolean);
}

/** Inspect repository-root-relative tracked and untracked changes without a model call.
 * Non-cancellation Git failures are advisory-unavailable and never block work. */
export async function analyzeSubagentRisk(
	cwd: string,
	runGit: GitRiskRunner = defaultGitRunner,
	signal?: AbortSignal,
): Promise<SubagentRiskAdvisory> {
	signal?.throwIfAborted();
	const resolvedCwd = resolve(cwd);
	try {
		const topLevel = (await runGit(resolvedCwd, ["rev-parse", "--show-toplevel"], signal)).trim();
		signal?.throwIfAborted();
		if (!topLevel) throw new Error("Git returned an empty repository top-level path.");
		const repositoryRoot = resolve(topLevel);
		const [tracked, untracked] = await Promise.all([
			runGit(repositoryRoot, ["diff", "--name-only", "-z", "HEAD"], signal),
			runGit(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"], signal),
		]);
		signal?.throwIfAborted();
		const changedPaths = [...new Set([...nulPaths(tracked), ...nulPaths(untracked)])].sort();
		const classification = classifyRiskPaths(changedPaths);
		return { available: true, changedPaths, ...classification };
	} catch (error) {
		if (isCancellation(error, signal)) throw error;
		return {
			available: false,
			changedPaths: [],
			categories: [],
			matches: {},
			recommendSentinel: false,
			unavailableReason: error instanceof Error ? error.message : String(error),
		};
	}
}

export function registerSubagentRiskTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent_risk",
		label: "Subagent Risk",
		description: "Advisory-only, no-model-call inspection of repository-root-relative tracked and untracked changes from HEAD, even when called from a nested cwd. Applies fixed path rules for concurrency, trust-boundary, persistence-compatibility, and failure-cancellation risk, and reports whether a fresh Sentinel review is suggested. It never dispatches a child or blocks work.",
		parameters: Type.Object({
			cwd: Type.Optional(Type.String({ description: "Repository working directory; defaults to the current caller cwd." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const advisory = await analyzeSubagentRisk(
				resolve(ctx.cwd, params.cwd ?? "."),
				defaultGitRunner,
				signal,
			);
			if (!advisory.available) {
				return {
					content: [{
						type: "text",
						text: `Sentinel risk advisory unavailable: ${advisory.unavailableReason ?? "Git could not inspect the working tree"}. Advisory only; no child was dispatched and work was not blocked.`,
					}],
					details: advisory,
				};
			}
			const changed = advisory.changedPaths.length > 0
				? advisory.changedPaths.map((path) => `- ${path}`).join("\n")
				: "- (none)";
			const categories = advisory.categories.length > 0 ? advisory.categories.join(", ") : "none";
			const recommendation = advisory.recommendSentinel
				? "Sentinel suggested by fixed path rules. Dispatch remains the main agent's decision."
				: "Sentinel not suggested by fixed path rules.";
			return {
				content: [{
					type: "text",
					text: `Changed paths relative to HEAD:\n${changed}\nRisk categories: ${categories}\n${recommendation} Advisory only; no child was dispatched and work was not blocked.`,
				}],
				details: advisory,
			};
		},
	});
}
