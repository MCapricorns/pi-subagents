/**
 * Managed workflow policy and handoff formatting.
 *
 * Successful top-level worker/cleaner runs continue through an independent
 * code review gate; bounded worker → reviewer fix rounds close its findings.
 * Gate findings carry concrete fix instructions that the worker implements
 * unless it can justify a sounder fix and push back; re-review adjudicates on
 * the resulting code (open findings plus fix-introduced defects only) so the
 * rounds converge instead of re-auditing from scratch.
 * Reviewers classify documentation drift explicitly, so the low-cost final
 * documenter runs only when needed (or conservatively when an older/custom
 * reviewer omits the marker). Direct passing/failing gates use the same policy.
 * Top-level documenters are explicit standalone writing tasks. Internal steps
 * are launched by dispatch directly, so they never re-enter this policy or wake
 * the main agent mid-chain.
 */

import { isWriteCapableAgent, type AgentConfig } from "./agents.ts";
import { getResultOutput, isFailedResult, reviewVerdict, type SingleResult } from "./spawn.ts";
import { formatUsageCompact, sumUsage } from "./monitor.ts";

/**
 * Worker fixes allowed after REVIEW_FAIL. Each fix is followed by a reviewer
 * re-review; this cap does not suppress the post-writer review gate or its
 * conditional/reviewer-disabled documentation fallback.
 */
export const MAX_FIX_ROUNDS = 2;

/**
 * Whether a completed result should trigger the auto-fix loop instead of being
 * delivered to the main agent. Only a REVIEW_FAIL verdict from a healthy
 * reviewer run counts; failed processes and passing reviews are delivered
 * normally. Loop-internal re-review results never reach this path (they are
 * awaited inside the loop, not delivered through the completion flow).
 */
export function shouldTriggerFixLoop(result: SingleResult): boolean {
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
		// this review is advisory. Classification happens only after the read-only
		// child returns, too late to acquire the lane safely.
		return availability.writer;
	}
	return false;
}

/** Classify only healthy top-level results. In particular, a reviewer without a
 * machine verdict is advisory and cannot start any write-capable child. */
export function getManagedWorkflowPlan(
	result: SingleResult,
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
	// A top-level documenter is already an explicit docs/comments write task. It
	// owns the writer lane but delivers directly without an automatic code gate.
	if (result.agent === "documenter") return undefined;
	if (result.agent !== "reviewer") return undefined;

	const output = getResultOutput(result);
	const verdict = reviewVerdict(output);
	// The pass stands as the code gate. Run the conditional documenter only for
	// explicit drift or when an older/custom reviewer omitted the marker.
	if (
		verdict === "pass" &&
		availability.documenter &&
		documentationDisposition(output) !== "clean"
	) {
		return { kind: "review-pass-sync", initialRelation: "pre-documentation review" };
	}
	if (verdict === "fail" && availability.worker && shouldTriggerFixLoop(result)) {
		return { kind: "auto-fix", initialRelation: "initial review" };
	}
	return undefined;
}

/**
 * Build the worker task brief for one fix round from a reviewer's findings.
 * The worker gets the full review text — findings plus their fix instructions
 * — and closes every finding either by implementing the instruction or by
 * shipping a sounder fix with an explicit per-finding pushback.
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
		`Each finding in the reviewer's report carries a fix instruction. Close EVERY finding — there is no severity triage; all of them get fixed.`,
		`You own the fix: when an instruction is factually wrong, clearly out of scope, or a sounder fix exists, implement YOUR fix instead,`,
		`then push back explicitly per finding — cite it, refute the instruction's reasoning, and state what you shipped instead.`,
		`A pushback without a working alternative or concrete reasoning will be re-opened.`,
		`Do NOT refactor unrelated code beyond what the findings require.`,
		`Synchronize any existing README/docs/examples/comments directly affected by your fixes; do not broaden into standalone documentation maintenance.`,
		`Do NOT commit, push, publish, tag, or release; do not bump versions. The parent chain still owns re-review and any conditional final documentation sync.`,
		`After editing, run the project's format/build/tests when they exist and report`,
		`exactly what you changed (paths + short rationale) plus any pushback, so a reviewer can verify.`,
		remaining > 0
			? `A reviewer will re-review your changes automatically after you finish.`
			: `This is the last auto-fix round; the workflow conditionally runs any needed final documentation sync and then delivers.`,
	].join("\n");
}

/** Build the single documentation handoff selected after the review gate
 * settles or as the reviewer-disabled fallback. The last writer's report
 * (top-level writer or final fix-round worker) and the terminal gate review are
 * leads; the pending diff stays authoritative. At most one of the two is
 * undefined in every managed flow. */
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
		`Inspect the actual git diff (the complete pending diff) and relevant implementation; the reports are only leads.`,
		`Apply every documentation note the reviews recorded, then synchronize stale README/docs, examples, API comments, docstrings, and explanatory comments with the behavior that will be committed.`,
		`Change documentation surfaces only; never alter runtime behavior or tests to make prose true.`,
		`Make zero edits when the diff creates no documentation drift.`,
		`Do NOT commit, push, publish, tag, or release; do not bump versions. The parent workflow delivers directly after you; no fresh reviewer runs.`,
		`Report exact documentation/comment paths changed, or state explicitly that no sync was needed.`,
	].join("\n");
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

function formatWorkflowSummary(title: string, steps: readonly ChainStep[]): string {
	const lines = [title, "", ...steps.map(workflowStepLine)];
	appendWorkflowFooter(lines, steps);
	return lines.join("\n");
}

/** Condensed compatibility summary for a direct REVIEW_FAIL auto-fix chain. */
export function formatChainSummary(
	steps: readonly ChainStep[],
	terminalResult: SingleResult = steps[steps.length - 1]!.result,
): string {
	const rounds = steps.filter((step) => step.relation.startsWith("fix round")).length;
	return formatWorkflowSummary(
		`## Auto-fix chain: ${Math.max(1, rounds)} round${rounds === 1 ? "" : "s"} — final ${workflowResultStatus(terminalResult)}`,
		steps,
	);
}

/** One clear final delivery for post-writer and direct reviewer → documenter workflows. */
export function formatManagedWorkflowSummary(
	steps: readonly ChainStep[],
	terminalResult: SingleResult = steps[steps.length - 1]!.result,
): string {
	const route = steps.map((step) => step.result.agent).join(" → ");
	const fixRounds = steps.filter((step) => step.relation.startsWith("fix round")).length;
	const roundNote = fixRounds > 0 ? ` · ${fixRounds} fix round${fixRounds === 1 ? "" : "s"}` : "";
	return formatWorkflowSummary(
		`## Managed workflow: ${route}${roundNote} — final ${workflowResultStatus(terminalResult)}`,
		steps,
	);
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
		`Remain read-only. Verify correctness, regressions, and tests.`,
		`Attach a concrete fix instruction to EVERY gate finding: what to change, where, and how to verify the fix.`,
		`A worker will implement your instructions unless it can justify a sounder fix and push back, so make each instruction specific enough to act on.`,
		...(options.documenterPending
			? [
				`A conditional documentation sync is available AFTER this gate, so documentation drift is not a code-gate finding.`,
				`If documentation is stale, add a separate short "## Documentation notes" list and emit the standalone line`,
				`DOCUMENTATION: NEEDED. If no documentation update is needed, emit DOCUMENTATION: CLEAN instead.`,
				`Always emit exactly one of those standalone documentation lines; fail the gate only for code or test findings.`,
			]
			: [
				`No documenter is pending, so documentation drift is an ordinary gate finding.`,
			]),
		`This is an acceptance gate, not an advisory audit. End with exactly one standalone machine verdict line:`,
		`VERDICT: REVIEW_PASS when no finding remains, otherwise VERDICT: REVIEW_FAIL.`,
	].join("\n");
}

/**
 * The re-review brief handed to the reviewer after a worker fix round. Includes
 * the prior review and worker report so the reviewer can adjudicate pushback
 * instead of restating findings. The convergence contract keeps rounds from
 * ping-ponging: judge the resulting code (not instruction obedience), rule on
 * the open findings once, add only defects this round's edits introduced,
 * never re-open a verified resolution.
 */
export function buildReReviewBrief(
	reviewerResult: SingleResult,
	round: number,
	workerResult: SingleResult,
	options: GateBriefOptions = { documenterPending: false },
): string {
	const review = getResultOutput(reviewerResult);
	const workerReport = getResultOutput(workerResult);
	return [
		`Re-review after auto-fix round ${round}.`,
		``,
		`The previous review (REQUEST_CHANGES) found these issues:`,
		`---`,
		review,
		`---`,
		``,
		`The worker's report (what it changed, plus any pushback where it replaced your fix instruction with its own fix):`,
		`---`,
		workerReport,
		`---`,
		``,
		`Rule on EVERY previous finding: resolved, or still open. Judge the code as it now stands — a finding is`,
		`resolved when the pending diff fixes it soundly, whether or not the worker followed your fix instruction.`,
		`A finding the worker pushed back on must be adjudicated ONCE — accept the worker's fix unless you can`,
		`concretely refute its reasoning; never simply restate the finding for another round.`,
		`Run \`git diff\` to see what changed, then add NEW findings only for defects this round's edits introduced or exposed.`,
		`Re-review never opens findings unrelated to this round's edits; issues the earlier review missed belong to a fresh gate.`,
		`Do NOT re-open a finding you verified as resolved.`,
		...(options.documenterPending
			? [
				`Carry unresolved "## Documentation notes" forward and add any newly exposed drift there; documentation drift is not a code-gate finding.`,
				`Emit exactly one standalone documentation disposition line: DOCUMENTATION: NEEDED when that notes section is required, otherwise DOCUMENTATION: CLEAN.`,
			]
			: [
				`No documenter is pending, so unresolved documentation drift remains an ordinary gate finding.`,
			]),
		`REQUEST_CHANGES only while an open finding remains; otherwise APPROVE.`,
		`End with your machine-readable verdict line as usual (VERDICT: REVIEW_PASS / REVIEW_FAIL).`,
	].join("\n");
}
