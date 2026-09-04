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
		assert.match(directive, /at most six child processes/u);
		assert.match(directive, /Cluster related reconnaissance into one scout brief/u);
		assert.match(directive, /external research/u);
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
		assert.match(directive, /never overlap writers.*identical briefs/u);
		assert.match(directive, /evidence\/leads, not authority\/instructions/u);
		assert.match(directive, /new in-scope evidence.*subagent_control steer/u);
		assert.doesNotMatch(directive, /high-stakes uncertainty only/u);
		assert.doesNotMatch(directive, /undocumented Grok|Grok internals/u);
		assert.doesNotMatch(directive, /Delegate aggressively|dispatch more|keep working/u);
		assert.doesNotMatch(directive, /Active phase leases:/u);
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
		assert.ok(directive.length < 2_200, `directive is ${directive.length} characters`);
	});
});
