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
