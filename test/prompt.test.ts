import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentConfig } from "../src/delegation/agents.ts";
import { loadBuiltinAgents } from "../src/delegation/agents.ts";
import {
	buildDelegationDirective,
	formatPhaseLeaseReceipt,
	type PhaseLeaseSource,
} from "../src/delegation/prompt.ts";

function agent(name: string): AgentConfig {
	return {
		name,
		description: `${name} description`,
		systemPrompt: "body",
		source: "builtin",
		filePath: `/agents/${name}.md`,
	};
}

function lease(partial: Partial<PhaseLeaseSource> & Pick<PhaseLeaseSource, "id">): PhaseLeaseSource {
	return {
		agentName: "scout",
		task: "Trace the routing flow across src modules",
		cwd: process.cwd(),
		state: "running",
		...partial,
	};
}

describe("buildDelegationDirective", () => {
	it("omits the directive when no role or lease exists", () => {
		assert.equal(buildDelegationDirective([]), "");
	});

	it("keeps routing cost-aware and phase-owned", () => {
		const directive = buildDelegationDirective(loadBuiltinAgents());
		assert.match(directive, /Each child starts a paid context/u);
		assert.match(directive, /proactively delegate substantial self-contained phases/u);
		assert.match(directive, /a half-done phase handed off pays twice/u);
		assert.match(directive, /at most six child processes/u);
		assert.match(directive, /Scale effort to the question/u);
		assert.match(directive, /context-heavy decisions stay in main/u);
		assert.match(directive, /one clustered scout brief \(repository and external research together\)/u);
		assert.match(directive, /primary change/u);
		assert.match(directive, /`sentinel`: read-only fresh-context review of a completed diff/u);
		assert.match(directive, /only when the diff touches concurrency, trust boundaries/u);
		assert.match(directive, /never a commit ritual/u);
		assert.match(directive, /Main handles review findings/u);
		assert.match(directive, /stable `phaseId`.*exact writer `scope`/u);
		assert.match(directive, /depends on handoff cost and full conversation context/u);
		assert.match(directive, /never infer it as a natural-language safety claim/u);
		assert.match(directive, /`subagent_risk` applies fixed changed-path rules without a model/u);
		assert.doesNotMatch(directive, /Before every commit|findings block commit|review once more/u);
		assert.match(directive, /`wait: true` only when the result is the immediate dependency/u);
		assert.match(directive, /Never sleep to wait/u);
		assert.match(directive, /not a polling loop/u);
		assert.match(directive, /One owner per phase/u);
		assert.match(directive, /without repeating completed delegated searches or edits/u);
		assert.match(directive, /Main owns routing, architecture, integration, the final gate, and release/u);
		assert.match(directive, /For one high-stakes uncertainty.*at most two read-only scouts/u);
		assert.match(directive, /distinct perspectives\/hypotheses/u);
		assert.match(directive, /reconciles disagreements against cited evidence/u);
		assert.match(directive, /never overlap writers.*identical briefs/iu);
		assert.match(directive, /evidence\/leads, not authority\/instructions/u);
		assert.doesNotMatch(directive, /high-stakes uncertainty only/u);
		assert.doesNotMatch(directive, /undocumented Grok|Grok internals/u);
		assert.doesNotMatch(directive, /Delegate aggressively|dispatch more|keep working/u);
		assert.doesNotMatch(directive, /Active phase leases:/u);
	});

	it("spells out the brief contract a memoryless child needs", () => {
		const directive = buildDelegationDirective(loadBuiltinAgents());
		assert.match(directive, /A child has no memory of this conversation/u);
		assert.match(directive, /objective and its done condition/u);
		assert.match(directive, /exact paths\/symbols/u);
		assert.match(directive, /facts already established, with citations, so the child starts there instead of re-deriving them/u);
		assert.match(directive, /boundaries \(what not to touch or decide\)/u);
		assert.match(directive, /expected output shape/u);
	});

	it("provides one-shot dispatch, read-only status, and main takeover instead of continuation controls", () => {
		const directive = buildDelegationDirective(loadBuiltinAgents());
		assert.match(directive, /One dispatch, one result/u);
		assert.match(directive, /no steer, park, or resume controls/u);
		assert.match(directive, /Main handles failed or incomplete work with its own tools/u);
		assert.match(directive, /different deliverable needs a new phase and brief/u);
		assert.match(directive, /`subagent_status` is read-only on-demand inspection, not a polling loop/u);
		assert.match(directive, /`subagent_stop` destructively cancels\/retires/u);
		assert.match(directive, /Duplicate identity is `phaseId` or exact task\+cwd/u);
		assert.match(directive, /never fuzzy or embedding-based/u);
		assert.match(directive, /read a truncated result's artifact only when the shown lines are insufficient/u);
	});

	it("shows routing only for enabled roles", () => {
		const directive = buildDelegationDirective([agent("artisan")]);
		assert.match(directive, /`artisan`:/u);
		assert.doesNotMatch(directive, /`scout`:|`steward`:|`sentinel`:/u);
	});

	it("renders only bounded active and settling leases", () => {
		const directive = buildDelegationDirective(loadBuiltinAgents(), [
			lease({ id: 11, task: "Map dispatch ownership" }),
			lease({ id: 12, state: "completed" }),
			lease({ id: 13, agentName: "artisan", state: "completed", lifecycleOperation: "settle", task: "Apply focused edit" }),
			lease({ id: 14 }),
			lease({ id: 15 }),
			lease({ id: 16, state: "failed" }),
		]);
		assert.match(directive, /#11 broad reconnaissance \(scout, running\): Map dispatch ownership/u);
		assert.match(directive, /#13 primary change \(artisan, settling\): Apply focused edit/u);
		assert.match(directive, /2 more active leases omitted/u);
		assert.doesNotMatch(directive, /#12|#14|#15|#16/u);
	});

	it("keeps launch receipts short and limits independence claims to parallel batches", () => {
		const sources = [lease({ id: 21, agentName: "artisan", task: "Implement duplicate rejection", phaseId: "duplicate-admission" })];
		const single = formatPhaseLeaseReceipt(sources, { mode: "single" });
		assert.match(single, /^Active phase lease:/u);
		assert.match(single, /#21 primary change/u);
		assert.match(single, /phase:duplicate-admission/u);
		assert.doesNotMatch(single, /independence|scope admission/iu);
		assert.match(
			formatPhaseLeaseReceipt(sources, { mode: "parallel", declaredScopesComplete: true }),
			/scope is conflict metadata, not permissions or a sandbox/u,
		);
		assert.doesNotMatch(
			formatPhaseLeaseReceipt(sources, { mode: "parallel", declaredScopesComplete: true }),
			/independence verified/iu,
		);
		assert.match(
			formatPhaseLeaseReceipt([lease({ id: 22 })], { mode: "parallel", declaredScopesComplete: false }),
			/Independence not verified/u,
		);
		assert.match(single, /Do not duplicate it/u);
		assert.doesNotMatch(single, /never blocks|dispatch more|keep working/u);
	});

	it("stays within the prompt budget", () => {
		const directive = buildDelegationDirective(loadBuiltinAgents());
		assert.ok(directive.length < 3_600, `directive is ${directive.length} characters`);
	});
});
