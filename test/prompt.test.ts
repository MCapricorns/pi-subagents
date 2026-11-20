import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentConfig } from "../src/delegation/agents.ts";
import { loadBuiltinAgents } from "../src/delegation/agents.ts";
import {
	DELEGATION_LEASE_SECTION,
	DELEGATION_SECTION,
	duplicateDispatchRemedy,
	formatPhaseLeaseReceipt,
	installDelegationSections,
	type PhaseLeaseSource,
} from "../src/delegation/prompt.ts";

function renderSections(agents: AgentConfig[], leases: Iterable<PhaseLeaseSource> = []): string {
	const sections: Record<string, string> = {};
	installDelegationSections(sections, agents, leases);
	return Object.values(sections).join("\n\n");
}

function agent(name: string): AgentConfig {
	return {
		name,
		description: `${name} description`,
		systemPrompt: "body",
	};
}

function lease(partial: Partial<PhaseLeaseSource> & Pick<PhaseLeaseSource, "id">): PhaseLeaseSource {
	return {
		agentName: "researcher",
		task: "Trace the routing flow across src modules",
		cwd: process.cwd(),
		state: "running",
		...partial,
	};
}

describe("renderSections", () => {
	it("omits the directive when no role or lease exists", () => {
		assert.equal(renderSections([]), "");
	});

	it("renders the orchestration, parallel concurrency, non-duplication, and background-wait contract within budget", () => {
		const roles = loadBuiltinAgents();
		const directive = renderSections(roles);
		assert.ok(directive.length < 3_600, `directive is ${directive.length} characters`);
		for (const role of roles) {
			assert.equal(directive.split(role.description).length - 1, 1);
			assert.ok(!directive.includes(role.systemPrompt));
		}
		assert.match(directive, /Main is the orchestrator: it plans, briefs, reviews, and integrates; workers execute/u);
		assert.match(directive, /Children inherit this session's live tool surface, including `codemode` when present; researcher keeps only read-only tools/u);
		assert.match(directive, /at most 5 concurrent subagents total; `tasks` accepts up to 5/u);
		assert.match(directive, /Batch independent phases together in one `tasks` call so they execute concurrently — never serialize independent work one by one/u);
		assert.match(directive, /neither another subagent nor main may repeat or edit that scope/u);
		assert.match(directive, /Leave `wait` omitted \(background mode\) by default so subagents run concurrently while main immediately continues its own disjoint work in parallel instead of waiting/u);
		assert.match(directive, /`subagent_message` to steer or continue a run/u);
		assert.doesNotMatch(directive, /workflow/iu);
		assert.doesNotMatch(directive, /Active phase leases:/u);

		const workerOnly = renderSections([agent("worker")]);
		assert.match(workerOnly, /- worker: worker description/u);
		assert.doesNotMatch(workerOnly, /\bresearcher\b/u);
	});

	it("keeps the stable contract cached when only leases change", () => {
		const sections: Record<string, string> = {};
		installDelegationSections(sections, loadBuiltinAgents(), []);
		assert.match(sections[DELEGATION_SECTION] ?? "", /- researcher: /u);
		assert.equal(sections[DELEGATION_LEASE_SECTION], undefined);

		installDelegationSections(sections, loadBuiltinAgents(), [lease({ id: 3 })]);
		const stable = sections[DELEGATION_SECTION];
		assert.match(stable ?? "", /- researcher: /u);
		assert.doesNotMatch(stable ?? "", /Active phase leases/u);
		assert.match(sections[DELEGATION_LEASE_SECTION] ?? "", /#3 researcher \(running\)/u);

		installDelegationSections(sections, loadBuiltinAgents(), [lease({ id: 3, task: "Map a different entry point" })]);
		assert.equal(sections[DELEGATION_SECTION], stable);
		assert.match(sections[DELEGATION_LEASE_SECTION] ?? "", /Map a different entry point/u);

		installDelegationSections(sections, [], []);
		assert.equal(sections[DELEGATION_SECTION], undefined);
		assert.equal(sections[DELEGATION_LEASE_SECTION], undefined);
	});

	it("shows all five concurrent active leases and five recent settled phases while bounding overflow", () => {
		const directive = renderSections(loadBuiltinAgents(), [
			lease({ id: 1, state: "completed" }),
			lease({ id: 2, state: "completed" }),
			lease({ id: 3, state: "completed" }),
			lease({ id: 4, state: "completed" }),
			lease({ id: 11, task: "Map dispatch ownership" }),
			lease({ id: 12, state: "completed" }),
			lease({ id: 13, agentName: "worker", state: "completed", lifecycleOperation: "settle", task: "Apply focused edit" }),
			lease({ id: 14, task: "Inspect config schema" }),
			lease({ id: 15, task: "Inspect worktree lock" }),
			lease({ id: 16, state: "failed" }),
			lease({ id: 17, task: "Inspect widget rows" }),
			lease({ id: 18, task: "Overflow lease A" }),
			lease({ id: 19, task: "Overflow lease B" }),
		]);
		for (const id of [11, 13, 14, 15, 17]) {
			assert.match(directive, new RegExp(`#${id} `, "u"));
		}
		assert.match(directive, /#13 worker \(settling\): Apply focused edit/u);
		assert.match(directive, /2 more active leases omitted/u);
		assert.doesNotMatch(directive, /#18|#19/u);
		assert.doesNotMatch(directive, /#1 /u);
		assert.match(directive, /Recent settled phases[\s\S]*#2 [\s\S]*#3 [\s\S]*#4 [\s\S]*#12 researcher \(completed\)[\s\S]*#16 researcher \(failed\)/u);
	});

	it("keeps launch receipts short and clear", () => {
		const sources = [lease({ id: 21, agentName: "worker", task: "Implement duplicate rejection" })];
		const single = formatPhaseLeaseReceipt(sources);
		assert.match(single, /^Active phase lease:/u);
		assert.match(single, /#21 worker \(running\): Implement duplicate rejection/u);
		assert.match(single, /Do not duplicate it/u);
		assert.doesNotMatch(single, /never blocks|dispatch more|keep working/u);
	});

	it("lists every run a parallel launch started", () => {
		const batch = formatPhaseLeaseReceipt([21, 22, 23, 24].map((id) => lease({ id, task: `Inspect module ${id}` })));
		assert.match(batch, /^Active phase leases:/u);
		for (const id of [21, 22, 23, 24]) assert.match(batch, new RegExp(`#${id} researcher \\(running\\): Inspect module ${id}`, "u"));
		assert.doesNotMatch(batch, /omitted/u);
		assert.match(batch, /Do not duplicate them/u);
	});
});

describe("duplicateDispatchRemedy", () => {
	it("keeps follow-up work with the owning run instead of moving it to main", () => {
		assert.match(duplicateDispatchRemedy(lease({ id: 4, state: "completed" })), /subagent_message\(\{ id: 4/u);
		const failed = duplicateDispatchRemedy(lease({ id: 5, state: "failed" }));
		assert.match(failed, /dispatch a corrected brief/u);
		assert.match(failed, /Do not repeat the same brief/u);
		assert.match(duplicateDispatchRemedy(lease({ id: 6, state: "parked" })), /subagent_stop\(\{ id: "6" \}\)/u);
		assert.match(duplicateDispatchRemedy(lease({ id: 7, state: "completed", retired: true })), /still stopping/u);
		assert.match(duplicateDispatchRemedy(lease({ id: 8 })), /let it finish or steer it/u);
	});
});
