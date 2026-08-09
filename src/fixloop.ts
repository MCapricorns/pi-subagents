/**
 * Auto-fix loop: when a reviewer returns REVIEW_FAIL, the extension dispatches a
 * worker (briefed with the review's concrete findings) and then a reviewer
 * re-review, repeating up to maxFixRounds times before waking the main agent with
 * the full chain. The reviewer stays read-only and in its own context; the loop
 * is orchestrated by the extension layer, not by the reviewer itself, so the
 * independence guarantee (no self-confirmation bias) is preserved.
 *
 * The main agent is never woken mid-loop: the reviewer's FAIL result is intercepted
 * before delivery, the chain runs in the background, and only the final group
 * (initial review → worker fixes → re-reviews) is delivered at the end.
 */

import { getResultOutput, isFailedResult, reviewVerdict, type SingleResult } from "./spawn.ts";
import { extractKeyFragments, formatUsageCompact } from "./monitor.ts";
import type { SubagentsConfig } from "./config.ts";

/**
 * Whether a completed result should trigger the auto-fix loop instead of being
 * delivered to the main agent. Only a REVIEW_FAIL verdict from a healthy
 * reviewer run counts; failed processes and passing reviews are delivered
 * normally. Loop-internal re-review results never reach this path (they are
 * awaited inside the loop, not delivered through the completion flow).
 */
export function shouldTriggerFixLoop(result: SingleResult, config: SubagentsConfig): boolean {
	if (config.maxFixRounds <= 0) return false;
	if (result.agent !== "reviewer") return false;
	if (isFailedResult(result)) return false;
	// A dispatch crash (spawn infra, delivery API, ...) is never a real review
	// verdict: its output is an error message plus whatever partial text the
	// child happened to emit, which could end in a stray `VERDICT: REVIEW_FAIL`.
	// Guard explicitly in addition to isFailedResult so the intent is clear and
	// a future change to isFailedResult can never let a crashed reviewer start a
	// phantom auto-fix chain (and re-add a run controller id that was deleted in
	// the catch path).
	if (result.dispatchFailed) return false;
	return reviewVerdict(getResultOutput(result)) === "fail";
}

/**
 * Build the worker task brief for one fix round from a reviewer's findings.
 * The worker gets the full review text so it can address concrete file:line
 * issues, with instructions to fix only blockers and self-verify.
 */
export function buildFixTaskBrief(reviewerResult: SingleResult, round: number, maxRounds: number): string {
	const review = getResultOutput(reviewerResult);
	const remaining = maxRounds - round;
	return [
		`Auto-fix round ${round} of ${maxRounds} (triggered by a failed review).`,
		``,
		`A reviewer ran in an isolated context and returned REQUEST_CHANGES. Its full report:`,
		`---`,
		review,
		`---`,
		``,
		`Fix the concrete blockers the reviewer flagged. Do NOT refactor unrelated code.`,
		`Address every "Critical" item; address "Warnings" only if they are genuine.`,
		`After editing, run the project's format/build/tests when they exist and report`,
		`exactly what you changed (paths + short rationale) so a reviewer can verify.`,
		remaining > 0
			? `A reviewer will re-review your changes automatically after you finish.`
			: `This is the last auto-fix round; the main agent will be woken with the full chain.`,
	].join("\n");
}

/**
 * One step of an auto-fix chain as delivered: the run id (so the condensed
 * summary can point at per-run detail via subagent_status), the result, and
 * the human-readable role within the chain ("initial review", "fix round 1",
 * "re-review round 2"). runId is undefined for steps that never spawned a run
 * (e.g. an unknown agent).
 */
export interface ChainStep {
	runId?: number;
	result: SingleResult;
	relation: string;
}

/** Max distinguishing fragments kept in a one-line chain summary. */
export const CHAIN_SUMMARY_FRAGMENTS_MAX = 3;

/** The most telling fragments (paths, quoted phrases, symbols) of a run's final
 * output: for a worker these are the paths it changed, for a reviewer the
 * issues it found. Capped so summaries stay one line. */
export function chainKeyFragments(result: SingleResult): string[] {
	return extractKeyFragments(getResultOutput(result)).slice(0, CHAIN_SUMMARY_FRAGMENTS_MAX);
}

/**
 * Compact one-line outcome for a finished chain run, shown in the widget so
 * each round reads as what it did: a reviewer reports its verdict plus the
 * key fragments of what it found ("fail · src/index.ts · render()"), a worker
 * the fragments of what it changed. Failed runs and runs with nothing
 * distinctive get no summary.
 */
export function summarizeChainResult(result: SingleResult): string | undefined {
	if (isFailedResult(result)) return undefined;
	const verdict = result.agent === "reviewer" ? reviewVerdict(getResultOutput(result)) : undefined;
	if (verdict === "pass") return "pass";
	const fragments = chainKeyFragments(result);
	if (verdict === "fail") return fragments.length > 0 ? `fail · ${fragments.join(" · ")}` : "fail";
	return fragments.length > 0 ? fragments.join(" · ") : undefined;
}

/**
 * Condensed, readable summary of a completed auto-fix chain: one line per step
 * (run id, role, verdict / what changed) plus aggregate usage. Full per-step
 * reports stay addressable via `subagent_status <id>`; the caller appends the
 * final step's full block only when its detail is actionable (FAIL verdict or a
 * crash), so the delivered message stays short instead of stacking every
 * round's raw output.
 */
export function formatChainSummary(steps: readonly ChainStep[]): string {
	const rounds = steps.filter((step) => step.relation.startsWith("fix round")).length;
	const last = steps[steps.length - 1];
	const stepStatus = (step: ChainStep): string => {
		const { result } = step;
		if (result.agent === "reviewer") {
			const verdict = reviewVerdict(getResultOutput(result));
			if (verdict) return verdict.toUpperCase();
		}
		return isFailedResult(result) ? "failed" : "completed";
	};
	const lines = [
		`## Auto-fix chain: ${Math.max(1, rounds)} round${rounds === 1 ? "" : "s"} — final ${stepStatus(last)}`,
		"",
	];
	for (const step of steps) {
		const fragments = chainKeyFragments(step.result);
		const suffix =
			fragments.length > 0
				? step.result.agent === "worker"
					? ` — changed: ${fragments.join(" · ")}`
					: ` — ${fragments.join(" · ")}`
				: "";
		const id = step.runId !== undefined ? `#${step.runId} ` : "";
		lines.push(`- ${id}${step.result.agent} · ${step.relation} · ${stepStatus(step)}${suffix}`);
	}
	const total = steps.reduce(
		(acc, step) => {
			acc.input += step.result.usage.input;
			acc.output += step.result.usage.output;
			acc.cacheRead += step.result.usage.cacheRead;
			acc.cacheWrite += step.result.usage.cacheWrite;
			acc.cost += step.result.usage.cost;
			acc.turns += step.result.usage.turns;
			return acc;
		},
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	);
	const usage = formatUsageCompact(total);
	lines.push("", `Totals: ${steps.length} run${steps.length === 1 ? "" : "s"}${usage ? ` · ${usage}` : ""}`);
	const ids = steps.filter((step) => step.runId !== undefined).map((step) => `#${step.runId}`);
	lines.push(`Full per-run reports (output, usage, failed tools): subagent_status ${ids.join(" ")}`);
	return lines.join("\n");
}

/**
 * The re-review brief handed to the reviewer after a worker fix round. Includes
 * the prior review so the reviewer can verify the fixes without re-discovering
 * the original issues.
 */
export function buildReReviewBrief(reviewerResult: SingleResult, round: number): string {
	const review = getResultOutput(reviewerResult);
	return [
		`Re-review after auto-fix round ${round}.`,
		``,
		`The previous review (REQUEST_CHANGES) found these issues:`,
		`---`,
		review,
		`---`,
		``,
		`Verify the worker's fixes address each blocker. Run \`git diff\` to see what changed.`,
		`Classify honestly: APPROVE if blockers are resolved, REQUEST_CHANGES if not.`,
		`End with your machine-readable verdict line as usual (VERDICT: REVIEW_PASS / REVIEW_FAIL).`,
	].join("\n");
}
