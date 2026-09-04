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
		assert.match(directive, /one clustered scout brief \(repository and external research together\)/u);
		assert.match(directive, /primary change/u);
		assert.doesNotMatch(directive, /sentinel|Before every commit/u);
		assert.match(directive, /`wait: true` only when the result is the immediate dependency/u);
		assert.match(directive, /Never sleep or poll/u);
		assert.match(directive, /One owner per phase/u);
		assert.match(directive, /never repeats delegated broad search, implementation, or cleanup/u);
		assert.match(directive, /Main owns routing, architecture, integration/u);
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

	it("routes follow-up work back to the same thread", () => {
		const directive = buildDelegationDirective(loadBuiltinAgents());
		assert.match(directive, /Same thread, never a second one/u);
		assert.match(directive, /`subagent_control steer` sends new in-scope evidence to a running phase/u);
		assert.match(directive, /a settled or parked thread continues with it/u);
		assert.match(directive, /`resume` continues a parked or finished thread with an appended objective and its retained context/u);
		assert.match(directive, /`park` pauses a running thread at a stable checkpoint/u);
		assert.match(directive, /`subagent_stop` ends a phase the evidence made moot/u);
		assert.match(directive, /An equivalent brief is rejected, not re-run/u);
		assert.match(directive, /read a truncated result's artifact only when the shown lines are insufficient/u);
	});

	it("shows routing only for enabled roles", () => {
		const directive = buildDelegationDirective([agent("artisan")]);
		assert.match(directive, /`artisan`:/u);
		assert.doesNotMatch(directive, /`scout`:|`steward`:/u);
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

	it("keeps launch receipts short and explicit", () => {
		const receipt = formatPhaseLeaseReceipt([
			lease({ id: 21, agentName: "artisan", task: "Implement duplicate rejection" }),
		]);
		assert.match(receipt, /^Active phase lease:/u);
		assert.match(receipt, /#21 primary change/u);
		assert.match(receipt, /Do not duplicate it/u);
		assert.doesNotMatch(receipt, /never blocks|dispatch more|keep working/u);
	});

	it("stays within the prompt budget", () => {
		const directive = buildDelegationDirective(loadBuiltinAgents());
		assert.ok(directive.length < 3_200, `directive is ${directive.length} characters`);
	});
});
