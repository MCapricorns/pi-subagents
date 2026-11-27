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
		assert.ok(directive.length < 2_100, `directive is ${directive.length} characters`);
		for (const role of roles) {
			assert.equal(directive.split(role.description).length - 1, 1);
			assert.ok(!directive.includes(role.systemPrompt));
		}
		assert.match(directive, /Main judges difficulty and owns the plan, integration, review, final checks, and release/u);
		assert.match(directive, /Call delegation tools directly, outside `codemode`/u);
		assert.match(directive, /Batch independent phases in one `subagent\(\{ tasks \}\)` call within free slots \(5 maximum\)\. Sequence dependencies/u);
		assert.match(directive, /disjoint files.*Leave leased work to its owner/u);
		assert.match(directive, /For research, give the question, sources, and evidence needed.*For implementation, give owned paths/u);
		assert.match(directive, /Omit `wait` in TUI\/RPC.*Use `wait: true` when the result is needed and no disjoint work remains/u);
		assert.match(directive, /Review the integrated diff, callers, acceptance criteria, and check evidence/u);
		assert.match(directive, /`subagent_message` to steer a running child or give a completed run a focused correction/u);
		assert.match(directive, /Address only failed launches in a partial batch/u);
		assert.match(directive, /For an authorized push, delegate a read-only audit.*Remove confirmed dead code and run project checks before committing and pushing/u);
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
		assert.match(sections[DELEGATION_LEASE_SECTION] ?? "", /4\/5 free/u);

		installDelegationSections(sections, loadBuiltinAgents(), [lease({ id: 3, task: "Map a different entry point" })]);
		assert.equal(sections[DELEGATION_SECTION], stable);
		assert.match(sections[DELEGATION_LEASE_SECTION] ?? "", /Map a different entry point/u);

		installDelegationSections(sections, [], []);
		assert.equal(sections[DELEGATION_SECTION], undefined);
		assert.equal(sections[DELEGATION_LEASE_SECTION], undefined);
	});

	it("shows all five concurrent active leases and five recent settled phases while bounding overflow", () => {
		const directive = renderSections(loadBuiltinAgents(), [
			lease({ id: 8, state: "parked", task: "An older interrupted owner" }),
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
			lease({ id: 18, state: "queued", task: "Check the public entry point" }),
			lease({ id: 19, lifecycleOperation: "stop", task: "Release the previous worktree" }),
		]);
		for (const id of [11, 14, 15, 17, 18]) {
			assert.match(directive, new RegExp(`#${id} `, "u"));
		}
		assert.match(directive, /Dispatch slots: 0\/5 free/u);
		assert.match(directive, /3 more active leases omitted/u);
		assert.doesNotMatch(directive, /#8 |#13 |#19 /u);
		assert.doesNotMatch(directive, /#1 /u);
		assert.match(directive, /Recent settled phases[\s\S]*#2 [\s\S]*#3 [\s\S]*#4 [\s\S]*#12 researcher \(completed\)[\s\S]*#16 researcher \(failed\)/u);
	});

	it("counts other calls' occupied slots while listing only the newly accepted run", () => {
		const threads = new Map([
			[18, lease({ id: 18, state: "parked" })],
			[19, lease({ id: 19, lifecycleOperation: "settle" })],
			[20, lease({ id: 20, state: "interrupting" })],
			[21, lease({ id: 21, agentName: "worker", task: "Implement duplicate rejection" })],
		]);
		const single = formatPhaseLeaseReceipt([21], threads);
		assert.match(single, /^Accepted 1 subagent run$/mu);
		assert.match(single, /#21 worker \(running\): Implement duplicate rejection/u);
		assert.match(single, /Dispatch slots: 3\/5 free/u);
		assert.doesNotMatch(single, /#18|#19|#20/u);
		assert.match(single, /Continue only disjoint work/u);
		assert.doesNotMatch(single, /never blocks|dispatch more|keep working/u);
	});

	it("lists every run a parallel launch started", () => {
		const sources = [
			...[21, 22, 23, 24].map((id) => lease({ id, task: `Inspect module ${id}` })),
			lease({ id: 25, state: "completed", task: "Inspect the last module" }),
		];
		const batch = formatPhaseLeaseReceipt(sources.map((source) => source.id), new Map(sources.map((source) => [source.id, source])));
		assert.match(batch, /^Accepted 5 subagent runs$/mu);
		for (const id of [21, 22, 23, 24]) assert.match(batch, new RegExp(`#${id} researcher \\(running\\): Inspect module ${id}`, "u"));
		assert.match(batch, /#25 researcher \(completed\): Inspect the last module/u);
		assert.doesNotMatch(batch, /omitted/u);
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
		assert.match(duplicateDispatchRemedy(lease({ id: 9, lifecycleOperation: "settle" })), /after integration/u);
		assert.match(duplicateDispatchRemedy(lease({ id: 10, state: "queued" })), /still starting/u);
	});
});
