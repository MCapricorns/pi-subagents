/**
 * Managed workflow policy and handoff formatting.
 *
 * Successful top-level worker/cleaner runs continue through one independent
 * code review gate. A failing managed gate continues into the reviewer fix
 * stage: the same retained reviewer session gets write access and applies its
 * own fix instructions, so nobody outside the gate has to guess what satisfies
 * it. Direct reviewer results never chain — a failing direct gate returns its
 * findings to the main agent, which owns that fix decision. Documentation
 * drift is an ordinary gate finding; dispatching a documenter stays the main
 * agent's call. Internal steps are launched by dispatch directly, so they
 * never re-enter this policy or wake the main agent mid-chain.
 */

import { isWriteCapableAgent, type AgentConfig } from "./agents.ts";
import { getResultOutput, isFailedResult, reviewVerdict, type SingleResult } from "./spawn.ts";
import { formatUsageCompact, sumUsage } from "./monitor.ts";

export interface WorkflowAgentAvailability {
	reviewer: boolean;
	writer: boolean;
}

export function workflowAgentAvailability(
	agents: readonly Pick<AgentConfig, "name" | "tools">[],
): WorkflowAgentAvailability {
	const names = new Set(agents.map((agent) => agent.name));
	return {
		reviewer: names.has("reviewer"),
		writer: agents.some(isWriteCapableAgent),
	};
}

export interface ManagedWorkflowPlan {
	initialRelation: string;
}

/** Dispatch-time gate intensity for one worker/cleaner task. "gate" (default)
 * keeps the automatic post-writer reviewer; "none" skips it so a mechanical,
 * low-risk edit does not pay for a full adversarial review — the dispatching
 * model owns that proportionality call because it knows the task's risk. */
export type ReviewMode = "gate" | "none";

/** Fixed cap on reviewer fix → re-review rounds inside one managed workflow.
 * Re-reviews converge by construction (they verify fixes and fix regressions
 * instead of re-scanning the whole surface); the cap only stops pathological
 * burn and hands the still-failing gate back to the main agent. */
export const MAX_REVIEW_FIX_ROUNDS = 2;

/** Conservative pre-run check used to reserve one shared-repository lane
 * around a complete writer workflow or a reviewer that needs a stable diff. */
export function canStartManagedWorkflow(
	agent: Pick<AgentConfig, "name" | "tools">,
	availability: WorkflowAgentAvailability,
): boolean {
	// Every shared write-capable role—including custom agents—owns the repository
	// lane even when no downstream role is enabled. Otherwise its edits can race
	// a managed writer's pending diff.
	if (isWriteCapableAgent(agent)) return true;
	if (agent.name === "reviewer") {
		// Hold a stable diff snapshot against every discoverable writer even when
		// this review is advisory: a gate over a moving diff is unsound.
		return availability.writer;
	}
	return false;
}

/** Classify only healthy top-level writer results; everything else delivers
 * directly, including every reviewer result — a direct reviewer dispatch never
 * starts another child. A failing managed gate is expanded by the workflow
 * itself into the reviewer fix stage. A dispatch that opted out of the gate
 * (review: "none") delivers directly too. */
export function getManagedWorkflowPlan(
	result: SingleResult,
	availability: WorkflowAgentAvailability,
	review: ReviewMode = "gate",
): ManagedWorkflowPlan | undefined {
	if (review === "none") return undefined;
	if (result.dispatchFailed || isFailedResult(result)) return undefined;
	if (result.agent === "worker" || result.agent === "cleaner") {
		if (!availability.reviewer) return undefined;
		return {
			initialRelation: result.agent === "cleaner" ? "initial cleanup" : "initial implementation",
		};
	}
	return undefined;
}

/** Build the code gate that runs directly after a top-level writer. Reports
 * carry intent; the actual pending diff remains authoritative. */
export function buildFinalReviewBrief(initialResult: SingleResult): string {
	return [
		`Fresh code gate for a managed ${initialResult.agent} workflow.`,
		``,
		`The top-level ${initialResult.agent}'s full report:`,
		`---`,
		getResultOutput(initialResult),
		`---`,
		``,
		`Run \`git status\` and \`git diff\` and judge the actual pending code; the report is context, not proof.`,
		`Scale the gate to the change: a small, contained diff gets a fast, focused review of its correctness,`,
		`regressions, and blast radius — not a whole-surface audit or a redesign of surrounding code it merely touches.`,
		`Remain read-only. Attach a concrete fix instruction to EVERY gate finding — including documentation drift —:`,
		`what to change, where, and how to verify it. A failing gate continues into your own write-enabled fix stage,`,
		`so make every instruction executable exactly as written.`,
		`End with exactly one standalone machine verdict line:`,
		`VERDICT: REVIEW_PASS when no finding remains, otherwise VERDICT: REVIEW_FAIL.`,
	].join("\n");
}

/** Build the follow-up brief for the reviewer fix stage: the same retained
 * reviewer session continues with its read-only boundary lifted and applies
 * its own fix instructions. The workflow continues with a converging re-review. */
export function buildReviewerFixBrief(gateOutput: string): string {
	return [
		`Fix stage: your gate review returned REVIEW_FAIL. You now have full write access in this same session.`,
		`Apply every one of your own fix instructions now — exactly the changes you specified, nothing broader.`,
		`Then re-check the code your fixes touch, so the next scan does not open with your own regression, and run`,
		`the narrowest decisive checks (type check, focused tests) to verify.`,
		``,
		`Your gate review:`,
		`---`,
		gateOutput,
		`---`,
		``,
		`Report:`,
		`## Fixed`,
		`- each finding → the exact fix applied (path + what changed)`,
		`## Verification`,
		`- checks actually run and their results`,
		`Do not emit another VERDICT; a converging gate re-reviews the diff after you.`,
	].join("\n");
}

/** Fresh gate over the updated diff after a fix round. The re-review runs in a
 * brand-new context but with a converging contract: verify the recorded fixes
 * landed and hunt regressions the fixes introduced. It must not reopen new
 * structural or style findings — the initial gate owned those — or every fresh
 * scan would surface fresh nits forever and the loop would never end. */
export function buildReReviewBrief(fixResult: SingleResult, round: number): string {
	return [
		`Re-review after fix round ${round}. This gate CONVERGES: it verifies fixes, it does not re-scan the whole surface.`,
		``,
		`The fix stage reported:`,
		`---`,
		getResultOutput(fixResult),
		`---`,
		``,
		`Verify every recorded fix actually landed in the code, and hunt regressions the fixes introduced in the touched`,
		`code and its direct blast radius (\`git status\` + \`git diff\`). Do NOT open new structural, style, or pre-existing`,
		`findings — the initial gate owned those; a remaining earlier finding counts only if its fix failed to land.`,
		`Remain read-only. Attach a concrete fix instruction to every finding you do report.`,
		`End with exactly one standalone machine verdict line:`,
		`VERDICT: REVIEW_PASS when nothing remains, otherwise VERDICT: REVIEW_FAIL.`,
	].join("\n");
}

/**
 * One step of a managed workflow as delivered: the run id (so the condensed
 * summary can point at per-run detail via subagent_status), the result, and
 * the human-readable role within the workflow ("initial implementation",
 * "final review"). runId is optional only for synthetic steps that never
 * spawned a child.
 */
export interface ChainStep {
	runId?: number;
	result: SingleResult;
	relation: string;
}

export interface ManagedWorkflowOutcome {
	steps: ChainStep[];
}

function workflowResultStatus(result: SingleResult, relation?: string): string {
	if (isFailedResult(result)) return "failed";
	// The fix stage is reviewer-named writer work: judge it by outcome, not by
	// the verdict contract its review stage was held to.
	if (relation === "review fix") return "completed";
	if (result.agent === "reviewer") {
		const verdict = reviewVerdict(getResultOutput(result));
		return verdict ? verdict.toUpperCase() : "NO_VERDICT";
	}
	return "completed";
}

function workflowStepLine(step: ChainStep): string {
	const id = step.runId !== undefined ? `#${step.runId} ` : "";
	return `- ${id}${step.result.agent} · ${step.relation} · ${workflowResultStatus(step.result, step.relation)}`;
}

function appendWorkflowFooter(lines: string[], steps: readonly ChainStep[]): void {
	const total = sumUsage(steps.map((step) => step.result.usage));
	const usage = formatUsageCompact(total);
	lines.push("", `Totals: ${steps.length} run${steps.length === 1 ? "" : "s"}${usage ? ` · ${usage}` : ""}`);
	const ids = steps.filter((step) => step.runId !== undefined).map((step) => `#${step.runId}`);
	lines.push(`Per-run details: subagent_status ${ids.join(" ")}`);
}

/** One clear final delivery for managed writer → gate workflows. */
export function formatManagedWorkflowSummary(
	steps: readonly ChainStep[],
	terminalResult: SingleResult = steps[steps.length - 1]!.result,
	terminalRelation: string = steps[steps.length - 1]!.relation,
): string {
	const route = steps.map((step) => step.result.agent).join(" → ");
	const lines = [`## Managed workflow: ${route} — final ${workflowResultStatus(terminalResult, terminalRelation)}`, "", ...steps.map(workflowStepLine)];
	appendWorkflowFooter(lines, steps);
	return lines.join("\n");
}
