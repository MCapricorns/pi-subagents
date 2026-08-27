/**
 * Managed workflow policy and handoff formatting.
 *
 * Successful top-level worker/cleaner runs continue through an independent
 * code review gate. A passing gate may run one conditional documentation
 * sync; a failing gate is delivered to the main agent, which owns the fix
 * decision — the runtime never edits code on a reviewer's behalf. Reviewers
 * classify documentation drift explicitly, so the low-cost final documenter
 * runs only when needed (or conservatively when an older/custom reviewer
 * omits the marker). Direct passing gates use the same policy. Top-level
 * documenters are explicit standalone writing tasks. Internal steps are
 * launched by dispatch directly, so they never re-enter this policy or wake
 * the main agent mid-chain.
 */

import { isWriteCapableAgent, type AgentConfig } from "./agents.ts";
import { getResultOutput, isFailedResult, reviewVerdict, type SingleResult } from "./spawn.ts";
import { formatUsageCompact, sumUsage } from "./monitor.ts";

export interface WorkflowAgentAvailability {
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
		cleaner: names.has("cleaner"),
		documenter: names.has("documenter"),
		reviewer: names.has("reviewer"),
		writer: agents.some(isWriteCapableAgent),
	};
}

export type DocumentationDisposition = "clean" | "needed";

/** Only the last standalone documentation disposition line counts. Inline
 * examples and prose are ignored so a prompt echo cannot suppress a needed
 * conservative sync. */
export function documentationDisposition(output: string): DocumentationDisposition | undefined {
	const lines = output.split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const match = /^\s*DOCUMENTATION:\s*(CLEAN|NEEDED)\s*$/i.exec(lines[index]);
		if (match) return match[1].toUpperCase() === "CLEAN" ? "clean" : "needed";
	}
	return undefined;
}

export type ManagedWorkflowKind = "post-writer" | "review-pass-sync";

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
		// this review is advisory. Classification happens only after the read-only
		// child returns, too late to acquire the lane safely.
		return availability.writer;
	}
	return false;
}

/** Classify only healthy top-level results. In particular, a reviewer without a
 * machine verdict is advisory and cannot start any write-capable child; a
 * failing gate is not a workflow at all — its findings are delivered to the
 * main agent, which decides the fixes. */
export function getManagedWorkflowPlan(
	result: SingleResult,
	availability: WorkflowAgentAvailability,
	advisoryReview = false,
): ManagedWorkflowPlan | undefined {
	if (result.dispatchFailed || isFailedResult(result)) return undefined;
	if (result.agent === "worker" || result.agent === "cleaner") {
		if (!availability.documenter && !availability.reviewer) return undefined;
		return {
			kind: "post-writer",
			initialRelation: result.agent === "cleaner" ? "initial cleanup" : "initial implementation",
		};
	}
	// A top-level documenter is already an explicit docs/comments write task. It
	// owns the writer lane but delivers directly without an automatic code gate.
	if (result.agent === "documenter") return undefined;
	if (result.agent !== "reviewer") return undefined;
	// An advisory dispatch never chains: the caller asked for a report, so even
	// a stray gate verdict must be delivered rather than acted on.
	if (advisoryReview) return undefined;

	const output = getResultOutput(result);
	// The pass stands as the code gate. Run the conditional documenter only for
	// explicit drift or when an older/custom reviewer omitted the marker.
	if (
		reviewVerdict(output) === "pass" &&
		availability.documenter &&
		documentationDisposition(output) !== "clean"
	) {
		return { kind: "review-pass-sync", initialRelation: "pre-documentation review" };
	}
	return undefined;
}

/** Build the single documentation handoff selected after the review gate
 * settles or as the reviewer-disabled fallback. The top-level writer's report
 * and the terminal gate review are leads; the pending diff stays authoritative.
 * At most one of the two is undefined in every managed flow. */
export function buildFinalDocumenterBrief(
	lastWriterResult?: SingleResult,
	finalReviewResult?: SingleResult,
): string {
	const reportSections = [
		...(lastWriterResult
			? [
				`The last writer (${lastWriterResult.agent}) reported:`,
				`---`,
				getResultOutput(lastWriterResult),
				`---`,
				``,
			]
			: []),
		...(finalReviewResult
			? [
				`The final gate review reported:`,
				`---`,
				getResultOutput(finalReviewResult),
				`---`,
				``,
			]
			: []),
	];
	return [
		`Final documentation sync: the review gate settled and you are the last managed stage before delivery.`,
		``,
		...reportSections,
		`Inspect the actual git diff and relevant implementation; the reports are only leads.`,
		`Apply every documentation note the reviews recorded, then synchronize stale README/docs, examples, API comments, docstrings,`,
		`and explanatory comments with the behavior that will be committed.`,
		`Change documentation surfaces only; make zero edits when the diff creates no documentation drift.`,
		`The workflow delivers directly after you; no fresh reviewer runs.`,
		`Report exact documentation/comment paths changed, or state explicitly that no sync was needed.`,
	].join("\n");
}

/**
 * One step of a managed workflow as delivered: the run id (so the condensed
 * summary can point at per-run detail via subagent_status), the result, and
 * the human-readable role within the workflow ("initial implementation",
 * "final review", "final documentation sync"). runId is optional only for
 * synthetic steps that never spawned a child.
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

function workflowResultStatus(result: SingleResult): string {
	if (isFailedResult(result)) return "failed";
	if (result.agent === "reviewer") {
		const verdict = reviewVerdict(getResultOutput(result));
		return verdict ? verdict.toUpperCase() : "NO_VERDICT";
	}
	return "completed";
}

function workflowStepLine(step: ChainStep): string {
	const id = step.runId !== undefined ? `#${step.runId} ` : "";
	return `- ${id}${step.result.agent} · ${step.relation} · ${workflowResultStatus(step.result)}`;
}

function appendWorkflowFooter(lines: string[], steps: readonly ChainStep[]): void {
	const total = sumUsage(steps.map((step) => step.result.usage));
	const usage = formatUsageCompact(total);
	lines.push("", `Totals: ${steps.length} run${steps.length === 1 ? "" : "s"}${usage ? ` · ${usage}` : ""}`);
	const ids = steps.filter((step) => step.runId !== undefined).map((step) => `#${step.runId}`);
	lines.push(`Per-run details: subagent_status ${ids.join(" ")}`);
}

/** One clear final delivery for post-writer and direct reviewer → documenter workflows. */
export function formatManagedWorkflowSummary(
	steps: readonly ChainStep[],
	terminalResult: SingleResult = steps[steps.length - 1]!.result,
): string {
	const route = steps.map((step) => step.result.agent).join(" → ");
	const lines = [`## Managed workflow: ${route} — final ${workflowResultStatus(terminalResult)}`, "", ...steps.map(workflowStepLine)];
	appendWorkflowFooter(lines, steps);
	return lines.join("\n");
}

export interface GateBriefOptions {
	/** A conditional final documenter is available after the gate settles.
	 * Documentation drift is then routed to it as non-gating notes instead of
	 * failing the code gate. */
	documenterPending: boolean;
}

/** Build the code gate that runs directly after a top-level writer, before any
 * documentation. Reports carry intent; the actual pending diff remains
 * authoritative. */
export function buildFinalReviewBrief(
	initialResult: SingleResult,
	options: GateBriefOptions,
): string {
	return [
		`Fresh code gate for a managed ${initialResult.agent} workflow.`,
		``,
		`The top-level ${initialResult.agent}'s full report:`,
		`---`,
		getResultOutput(initialResult),
		`---`,
		``,
		`Run \`git status\` and \`git diff\` and inspect the actual pending code; the report is context, not proof.`,
		`Remain read-only. Attach a concrete fix instruction to EVERY gate finding: what to change, where, and how to verify the fix`,
		`— the report returns to the main agent, which uses your instructions to drive the fix.`,
		...(options.documenterPending
			? [
				`A conditional documentation sync is available AFTER this gate, so documentation drift is not a code-gate finding:`,
				`record it under "## Documentation notes" and emit the standalone line DOCUMENTATION: NEEDED,`,
				`or DOCUMENTATION: CLEAN when no documentation update is needed.`,
			]
			: [
				`No documenter is pending, so documentation drift is an ordinary gate finding.`,
			]),
		`This is an acceptance gate, not an advisory audit. End with exactly one standalone machine verdict line:`,
		`VERDICT: REVIEW_PASS when no finding remains, otherwise VERDICT: REVIEW_FAIL.`,
	].join("\n");
}
