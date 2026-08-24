/**
 * Managed workflow policy and handoff formatting.
 *
 * Successful top-level writers can continue through documentation sync and an
 * independent final review. A direct passing reviewer is also forced through
 * documentation sync plus a fresh review when documenter is enabled. Any final
 * gate failure may then use the established worker → optional documenter →
 * reviewer fix rounds. Internal steps are launched by dispatch directly, so
 * they never re-enter this top-level policy or wake the main agent mid-chain.
 */

import { isWriteCapableAgent, type AgentConfig } from "./agents.ts";
import { getResultOutput, isFailedResult, reviewVerdict, type SingleResult } from "./spawn.ts";
import { extractKeyFragments, formatUsageCompact, sumUsage } from "./monitor.ts";
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
	// phantom auto-fix chain.
	if (result.dispatchFailed) return false;
	return reviewVerdict(getResultOutput(result)) === "fail";
}

export interface WorkflowAgentAvailability {
	worker: boolean;
	cleaner: boolean;
	documenter: boolean;
	reviewer: boolean;
	writer: boolean;
}

export function workflowAgentAvailability(
	agents: readonly Pick<AgentConfig, "name" | "tools">[],
): WorkflowAgentAvailability {
	const names = new Set(agents.map((agent) => agent.name));
	return {
		worker: names.has("worker"),
		cleaner: names.has("cleaner"),
		documenter: names.has("documenter"),
		reviewer: names.has("reviewer"),
		writer: agents.some(isWriteCapableAgent),
	};
}

export type ManagedWorkflowKind = "auto-fix" | "post-writer" | "review-pass-sync";

export interface ManagedWorkflowPlan {
	kind: ManagedWorkflowKind;
	initialRelation: string;
}

/** Conservative pre-run check used to reserve one shared-repository lane
 * around a complete writer workflow or a reviewer that needs a stable diff.
 * The actual result is classified again by getManagedWorkflowPlan before a
 * downstream child starts. */
export function canStartManagedWorkflow(
	agent: Pick<AgentConfig, "name" | "tools">,
	availability: WorkflowAgentAvailability,
): boolean {
	// Every shared write-capable role—including custom agents—owns the repository
	// lane even when no downstream role is enabled. Otherwise its edits can race
	// a managed writer's documentation snapshot.
	if (isWriteCapableAgent(agent)) return true;
	if (agent.name === "reviewer") {
		// Hold a stable diff snapshot against every discoverable writer even when
		// this review is advisory or maxFixRounds=0. Classification happens only
		// after the read-only child returns, too late to acquire the lane safely.
		return availability.writer;
	}
	return false;
}

/** Classify only healthy top-level results. In particular, a reviewer without a
 * machine verdict is advisory and cannot start any write-capable child. */
export function getManagedWorkflowPlan(
	result: SingleResult,
	config: SubagentsConfig,
	availability: WorkflowAgentAvailability,
): ManagedWorkflowPlan | undefined {
	if (result.parked || result.dispatchFailed || isFailedResult(result)) return undefined;
	if (result.agent === "worker" || result.agent === "cleaner") {
		if (!availability.documenter && !availability.reviewer) return undefined;
		return {
			kind: "post-writer",
			initialRelation: result.agent === "cleaner" ? "initial cleanup" : "initial implementation",
		};
	}
	if (result.agent === "documenter") {
		return availability.reviewer
			? { kind: "post-writer", initialRelation: "documentation pass" }
			: undefined;
	}
	if (result.agent !== "reviewer") return undefined;

	const verdict = reviewVerdict(getResultOutput(result));
	if (verdict === "pass" && availability.documenter && availability.reviewer) {
		return { kind: "review-pass-sync", initialRelation: "pre-documentation review" };
	}
	if (verdict === "fail" && availability.worker && shouldTriggerFixLoop(result, config)) {
		return { kind: "auto-fix", initialRelation: "initial review" };
	}
	return undefined;
}

/**
 * Build the worker task brief for one fix round from a reviewer's findings.
 * The worker gets the full review text so it can address concrete file:line
 * issues, with instructions to fix every reported finding and self-verify.
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
		`Fix EVERY finding in the reviewer's findings list — there is no severity triage; all of them get fixed.`,
		`If a finding is factually wrong or clearly out of scope, say so explicitly instead of fixing it.`,
		`Do NOT refactor unrelated code beyond what the findings require.`,
		`Do NOT commit, push, publish, tag, or release; do not bump versions. The parent chain still owns documentation sync and final review.`,
		`After editing, run the project's format/build/tests when they exist and report`,
		`exactly what you changed (paths + short rationale) so a reviewer can verify.`,
		remaining > 0
			? `A reviewer will re-review your changes automatically after you finish.`
			: `This is the last auto-fix round; optional documentation sync and a fresh reviewer still run before final delivery.`,
	].join("\n");
}

interface DocumentationBriefOptions {
	title: string;
	reports: Array<{ label: string; result: SingleResult }>;
	closing: string;
}

function buildDocumentationBrief(options: DocumentationBriefOptions): string {
	const reportSections = options.reports.flatMap(({ label, result }) => [
		`${label}:`,
		`---`,
		getResultOutput(result),
		`---`,
		``,
	]);
	return [
		options.title,
		``,
		...reportSections,
		`Inspect the actual git diff (the complete pending diff) and relevant implementation; the report is only a lead.`,
		`Synchronize stale README/docs, examples, API comments, docstrings, and explanatory comments with the behavior that will be committed.`,
		`Change documentation surfaces only; never alter runtime behavior or tests to make prose true.`,
		`Make zero edits when the diff creates no documentation drift.`,
		`Do NOT commit, push, publish, tag, or release; do not bump versions. ${options.closing}`,
		`Report exact documentation/comment paths changed, or state explicitly that no sync was needed.`,
	].join("\n");
}

/** Build the pre-commit documentation handoff after one auto-fix worker. */
export function buildDocumenterTaskBrief(
	workerResult: SingleResult,
	round: number,
	reviewerResult?: SingleResult,
): string {
	return buildDocumentationBrief({
		title: `Documentation sync after auto-fix round ${round}.`,
		reports: [
			...(reviewerResult ? [{ label: "The triggering reviewer reported", result: reviewerResult }] : []),
			{ label: "The worker reported", result: workerResult },
		],
		closing: "a fresh reviewer gate runs after you.",
	});
}

/** Build the automatic documentation stage after a successful top-level writer. */
export function buildPostWriterDocumenterBrief(writerResult: SingleResult): string {
	return buildDocumentationBrief({
		title: `Documentation sync after successful top-level ${writerResult.agent}.`,
		reports: [{ label: `The ${writerResult.agent} reported`, result: writerResult }],
		closing: "the managed workflow owns any final reviewer and delivery.",
	});
}

/** A direct passing review cannot be the final gate while documenter is enabled:
 * the preliminary report is context, but the actual pending diff is authoritative. */
export function buildReviewPassDocumenterBrief(reviewerResult: SingleResult): string {
	return buildDocumentationBrief({
		title: "Documentation sync required before accepting a direct passing review.",
		reports: [{ label: "The preliminary reviewer reported", result: reviewerResult }],
		closing: "the preliminary pass is not final and a fresh reviewer gate runs after you.",
	});
}

/**
 * One step of an auto-fix chain as delivered: the run id (so the condensed
 * summary can point at per-run detail via subagent_status), the result, and
 * the human-readable role within the chain ("initial review", "fix round 1",
 * "re-review round 2"). runId is optional only for synthetic steps that never
 * spawned a child.
 */
export interface ChainStep {
	runId?: number;
	result: SingleResult;
	relation: string;
}

export interface ManagedWorkflowOutcome {
	kind: ManagedWorkflowKind;
	steps: ChainStep[];
}

/** Max distinguishing fragments kept in a one-line chain summary. */
export const CHAIN_SUMMARY_FRAGMENTS_MAX = 3;

/** The most telling fragments (paths, quoted phrases, symbols) of a run's final
 * output: for a worker these are the paths it changed, for a reviewer the
 * issues it found. Capped so summaries stay one line. */
export function chainKeyFragments(result: SingleResult): string[] {
	return extractKeyFragments(getResultOutput(result)).slice(0, CHAIN_SUMMARY_FRAGMENTS_MAX);
}

function workflowResultStatus(result: SingleResult): string {
	if (isFailedResult(result)) return "failed";
	if (result.agent === "reviewer") {
		const verdict = reviewVerdict(getResultOutput(result));
		return verdict ? verdict.toUpperCase() : "NO_VERDICT";
	}
	return "completed";
}

function workflowStepLine(step: ChainStep): string {
	const fragments = chainKeyFragments(step.result);
	const writer = step.result.agent === "worker" || step.result.agent === "cleaner" || step.result.agent === "documenter";
	const suffix = fragments.length > 0
		? writer
			? ` — changed: ${fragments.join(" · ")}`
			: ` — ${fragments.join(" · ")}`
		: "";
	const id = step.runId !== undefined ? `#${step.runId} ` : "";
	return `- ${id}${step.result.agent} · ${step.relation} · ${workflowResultStatus(step.result)}${suffix}`;
}

function appendWorkflowFooter(lines: string[], steps: readonly ChainStep[]): void {
	const total = sumUsage(steps.map((step) => step.result.usage));
	const usage = formatUsageCompact(total);
	lines.push("", `Totals: ${steps.length} run${steps.length === 1 ? "" : "s"}${usage ? ` · ${usage}` : ""}`);
	const ids = steps.filter((step) => step.runId !== undefined).map((step) => `#${step.runId}`);
	lines.push(`Full per-run reports (output, usage, failed tools): subagent_status ${ids.join(" ")}`);
}

/** Condensed compatibility summary for a direct REVIEW_FAIL auto-fix chain. */
export function formatChainSummary(
	steps: readonly ChainStep[],
	terminalResult: SingleResult = steps[steps.length - 1]!.result,
): string {
	const rounds = steps.filter((step) => step.relation.startsWith("fix round")).length;
	const lines = [
		`## Auto-fix chain: ${Math.max(1, rounds)} round${rounds === 1 ? "" : "s"} — final ${workflowResultStatus(terminalResult)}`,
		"",
		...steps.map(workflowStepLine),
	];
	appendWorkflowFooter(lines, steps);
	return lines.join("\n");
}

/** One clear final delivery for all newly managed writer/documenter workflows. */
export function formatManagedWorkflowSummary(
	steps: readonly ChainStep[],
	terminalResult: SingleResult = steps[steps.length - 1]!.result,
): string {
	const route = steps.map((step) => step.result.agent).join(" → ");
	const fixRounds = steps.filter((step) => step.relation.startsWith("fix round")).length;
	const roundNote = fixRounds > 0 ? ` · ${fixRounds} fix round${fixRounds === 1 ? "" : "s"}` : "";
	const lines = [
		`## Managed workflow: ${route}${roundNote} — final ${workflowResultStatus(terminalResult)}`,
		"",
		...steps.map(workflowStepLine),
	];
	appendWorkflowFooter(lines, steps);
	return lines.join("\n");
}

/** Build the first independent final gate after a top-level writer or required
 * post-pass documentation sync. Reports carry intent; the actual pending diff
 * remains authoritative. */
export function buildFinalReviewBrief(
	initialResult: SingleResult,
	documenterResult?: SingleResult,
): string {
	const documenterSection = documenterResult
		? [
			``,
			`The documenter's full sync report:`,
			`---`,
			getResultOutput(documenterResult),
			`---`,
		]
		: [];
	return [
		`Fresh final gate for a managed ${initialResult.agent} workflow.`,
		``,
		`The top-level ${initialResult.agent}'s full report:`,
		`---`,
		getResultOutput(initialResult),
		`---`,
		...documenterSection,
		``,
		`Run \`git status\` and \`git diff\` and inspect the actual pending code and documentation; reports are context, not proof.`,
		`Remain read-only. Verify correctness, regressions, tests, documentation drift, and that documenter was the last writer when it ran.`,
		`This is an acceptance gate, not an advisory audit. End with exactly one standalone machine verdict line:`,
		`VERDICT: REVIEW_PASS when no finding remains, otherwise VERDICT: REVIEW_FAIL.`,
	].join("\n");
}

/**
 * The re-review brief handed to the reviewer after a worker fix round. Includes
 * the prior review, worker report, and optional documenter report so the
 * reviewer can adjudicate rejections instead of restating findings. The
 * convergence contract keeps rounds from ping-ponging: rule on the open
 * findings once, add only defects this round's edits introduced, never re-open
 * a verified resolution.
 */
export function buildReReviewBrief(
	reviewerResult: SingleResult,
	round: number,
	workerResult: SingleResult,
	documenterResult?: SingleResult,
): string {
	const review = getResultOutput(reviewerResult);
	const workerReport = getResultOutput(workerResult);
	const documenterSection = documenterResult
		? [
			``,
			`The documenter's pre-commit sync report:`,
			`---`,
			getResultOutput(documenterResult),
			`---`,
		]
		: [];
	return [
		`Re-review after auto-fix round ${round}.`,
		``,
		`The previous review (REQUEST_CHANGES) found these issues:`,
		`---`,
		review,
		`---`,
		``,
		`The worker's report (what it changed, plus any finding it rejected as factually wrong or out of scope):`,
		`---`,
		workerReport,
		`---`,
		...documenterSection,
		``,
		`Rule on EVERY previous finding: resolved, or still open. A finding the worker rejected must be`,
		`adjudicated ONCE — accept the rejection unless you can concretely refute the worker's reasoning;`,
		`never simply restate the finding for another round.`,
		`Run \`git diff\` to see what changed, then add NEW findings only when they are defects this round's`,
		`edits introduced or exposed (or a load-bearing issue the earlier review genuinely missed).`,
		`Do NOT re-open a finding you verified as resolved.`,
		`REQUEST_CHANGES only while an open finding remains; otherwise APPROVE.`,
		`End with your machine-readable verdict line as usual (VERDICT: REVIEW_PASS / REVIEW_FAIL).`,
	].join("\n");
}
