/**
 * Builds the delegation directive installed into the parent prompt.
 *
 * The stable contract and the live leases are separate system-prompt
 * sections. Pi appends a section delta only when that text changes, so an idle
 * turn keeps the cached prefix.
 * Detailed role guidance remains in each child's own prompt.
 */

/** Stable routing contract. Pi wraps this in `<subagents>`. */
export const DELEGATION_SECTION = "subagents";
/** Bounded live and recent phase ownership, omitted when no owner remains. */
export const DELEGATION_LEASE_SECTION = "subagent_leases";

import { resolve } from "node:path";
import type { AgentConfig } from "./agents.ts";
import { formatCatalogEntry } from "./agents.ts";
import { ORCHESTRATION_SECTION } from "./orchestration.ts";
import { MAX_CONCURRENT_SUBAGENTS } from "../execution/background.ts";
import { dispatchCapacity } from "../lifecycle/thread-shared.ts";

export interface PhaseLeaseSource {
	id: number;
	agentName: string;
	task: string;
	cwd: string;
	state: "queued" | "running" | "interrupting" | "parked" | "completed" | "failed" | "stopped";
	lifecycleOperation?: "stop" | "settle";
	retired?: boolean;
}

interface DuplicateDispatch {
	source: PhaseLeaseSource;
	/** Active leases take priority; settled phases still reject duplicate work. */
	kind: "active" | "settled";
}

const ACTIVE_LEASE_STATES = new Set<PhaseLeaseSource["state"]>([
	"queued",
	"running",
	"interrupting",
	"parked",
]);
const MAX_ACTIVE_LEASES = MAX_CONCURRENT_SUBAGENTS;
const MAX_RECENT_SETTLED_LEASES = MAX_CONCURRENT_SUBAGENTS;
const MAX_LEASE_TASK_LENGTH = 56;

function bullets(lines: readonly string[]): string {
	return lines.map((line) => `- ${line}`).join("\n");
}

function isActivePhaseLease(source: PhaseLeaseSource): boolean {
	return source.lifecycleOperation !== undefined || ACTIVE_LEASE_STATES.has(source.state);
}

function normalizedTask(task: string): string {
	return task.replace(/\s+/gu, " ").trim();
}

function normalizedCwd(cwd: string): string {
	const resolved = resolve(cwd);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSettledLease(source: PhaseLeaseSource): boolean {
	return (source.state === "completed" || source.state === "failed") && !source.retired && source.lifecycleOperation === undefined;
}

/** An equal normalized task in the same cwd identifies a duplicate, regardless
 * of role. Active leases win over settled. */
export function findDuplicateDispatch(
	sources: Iterable<PhaseLeaseSource>,
	task: string,
	cwd: string,
): DuplicateDispatch | undefined {
	const taskKey = normalizedTask(task);
	const cwdKey = normalizedCwd(cwd);
	const matches = [...sources].filter((source) =>
		normalizedCwd(source.cwd) === cwdKey && normalizedTask(source.task) === taskKey,
	);
	const active = matches.find(isActivePhaseLease);
	if (active) return { source: active, kind: "active" };
	const settled = matches.find(isSettledLease);
	return settled ? { source: settled, kind: "settled" } : undefined;
}

/** Next step for a rejected duplicate, shared by single and parallel admission
 * so both keep follow-up work with the owning run instead of moving it to main. */
export function duplicateDispatchRemedy(owner: PhaseLeaseSource): string {
	if (owner.retired || owner.lifecycleOperation === "stop") return "It is still stopping; dispatch the phase again after the stop finishes.";
	if (owner.lifecycleOperation === "settle") return "Its result arrives automatically after integration. Continue disjoint work or pause until then.";
	switch (owner.state) {
		case "queued":
			return "It is still starting. Continue disjoint work or pause for its result.";
		case "interrupting":
			return "It is being interrupted. Inspect the retained result with subagent_status once the interruption finishes.";
		case "parked":
			return `That interrupted run keeps the phase claimed. Inspect its retained result with subagent_status and finish from that evidence. Retire it with subagent_stop({ id: "${owner.id}" }) only if discarding its retained session is intended; then the phase can be reused.`;
		case "completed":
			return `Reuse its result via subagent_status({ id: ${owner.id} }); use subagent_message({ id: ${owner.id}, message: "<bounded next step>" }) for additional work. A new deliverable needs its own brief.`;
		case "failed":
			return "Inspect the failure with subagent_status, then dispatch a corrected brief that names the failure evidence and remaining work, or finish in main. Do not repeat the same brief.";
		default:
			return "Do not redispatch it; let it finish or steer it with subagent_message. Its result returns automatically; then continue the task.";
	}
}

/** A follow-up can check ownership before copying history. Fresh admission
 * checks it again when synchronously reserving the new run. */
export function duplicatePhaseConflict(sources: Iterable<PhaseLeaseSource>, task: string, cwd: string): string | undefined {
	const duplicate = findDuplicateDispatch(sources, task, cwd);
	if (!duplicate) return undefined;
	const owner = duplicate.source;
	return `Run #${owner.id} (${owner.agentName}) already owns this logical phase (${owner.state}). ${duplicateDispatchRemedy(owner)}`;
}

function summarizeLeaseTask(task: string): string {
	const oneLine = normalizedTask(task);
	const characters = [...oneLine];
	return characters.length <= MAX_LEASE_TASK_LENGTH
		? oneLine
		: `${characters.slice(0, MAX_LEASE_TASK_LENGTH - 1).join("")}…`;
}

function leaseLine(source: PhaseLeaseSource): string {
	const state = source.lifecycleOperation === "settle" ? "settling"
		: source.lifecycleOperation === "stop" ? "stopping"
			: source.state === "parked" ? "interrupted" : source.state;
	return `- #${source.id} ${source.agentName} (${state}): ${summarizeLeaseTask(source.task)}`;
}

/** Prompt-section view of active leases, bounded so a wide batch cannot grow
 * every later prompt. */
function formatActivePhaseLeases(sources: Iterable<PhaseLeaseSource>, slotOwners: ReadonlySet<number>): string {
	const priority = (source: PhaseLeaseSource) => slotOwners.has(source.id) ? 0 : source.state === "parked" ? 2 : 1;
	const active = [...sources].filter(isActivePhaseLease)
		.sort((left, right) => priority(left) - priority(right));
	if (active.length === 0) return "";
	const lines = active.slice(0, MAX_ACTIVE_LEASES).map(leaseLine);
	if (active.length > MAX_ACTIVE_LEASES) {
		lines.push(`- … ${active.length - MAX_ACTIVE_LEASES} more active lease${active.length - MAX_ACTIVE_LEASES === 1 ? "" : "s"} omitted; inspect subagent_status before choosing disjoint work`);
	}
	return lines.join("\n");
}

/** Launch receipt listing every run the call started, so each id stays
 * addressable for steering, status, and stop. */
export function formatPhaseLeaseReceipt(runIds: readonly number[], threads: ReadonlyMap<number, PhaseLeaseSource>): string {
	const accepted = runIds.map((id) => threads.get(id)).filter((source) => source !== undefined);
	if (accepted.length === 0) return "";
	const count = accepted.length;
	const { available } = dispatchCapacity(threads.values());
	return [
		`Accepted ${count} subagent ${count === 1 ? "run" : "runs"}`, ...accepted.map(leaseLine),
		formatDispatchSlots(available), "Continue only disjoint work. Results return automatically after settlement.",
	].join("\n");
}

export function formatDispatchSlots(available: number): string {
	return `Dispatch slots: ${available}/${MAX_CONCURRENT_SUBAGENTS} free.`;
}

function delegationBody(agents: AgentConfig[]): string {
	const catalog = agents.length > 0 ? agents.map(formatCatalogEntry).join("\n") : "- (none enabled)";
	const readOnly = agents.some((agent) => agent.name === "researcher") ? " Researcher receives read-only lookups only." : "";
	const routing = [
		"Main judges difficulty and owns planning, integration, final checks, and release. Honor the user's scope and requests to work in main. Questions and review-only requests authorize investigation, with implementation requiring a request for changes.",
		"Delegate simple, bounded work by default when it saves main's context or lets independent work proceed. Investigate enough to decide the approach. Keep tightly coupled, tiny, or high-uncertainty work in main when briefing and handoff would cost more.",
		`Call delegation tools directly, outside \`codemode\`. Child tools come from this session's reachable tools, including \`codemode\` where supported.${readOnly}`,
	];
	const dispatch = [
		`Use \`subagent({ agent, task })\` for one phase. Batch independent phases in one \`subagent({ tasks })\` call within the free slots (${MAX_CONCURRENT_SUBAGENTS} maximum). Sequence dependent phases. Give each writer a disjoint scope and keep a change with its tests. Leave an owned phase to its current run.`,
		"Start each brief with the outcome. For research, name the question, sources, and evidence needed. For implementation, name the owned paths, acceptance criteria, exact checks, and when to return for replanning. Include only the context the child needs.",
		"Omit `wait` for background work in TUI/RPC. Continue disjoint work, or end the turn and let results wake you after integration. Use `wait: true` when the next step depends on this result and no disjoint work can proceed. Avoid polling. Print/JSON waits by default.",
	];
	const review = [
		"Treat child output as evidence. Review the actual diff, affected callers, and check evidence against the acceptance criteria. Reuse checks that still cover the code and read the result file when output was truncated.",
		"Use `subagent_message` to steer a running child or give a completed run a focused correction. Inspect failed or interrupted results with `subagent_status`, then correct the brief or finish in main. In a partial batch, leave accepted runs alone and address only the failed launches.",
		"For an authorized push of code changes, first delegate a read-only audit of the diff for dead code and unused files, exports, or dependencies. If unavailable, audit in main. Remove confirmed dead code within scope. Delegate bounded fixes when practical. Run project checks before committing and pushing.",
	];

	return `## Subagent orchestration

### Choose scope and role
${catalog}
${bullets(routing)}

### Dispatch
${bullets(dispatch)}

### Review and finish
${bullets(review)}`;
}

/** Routing contract without live leases. Empty when no role is enabled and no lease forces the catalog. */
function buildStableDelegationSection(agents: AgentConfig[], includeEmptyCatalog = false): string {
	if (agents.length === 0 && !includeEmptyCatalog) return "";
	return delegationBody(agents);
}

/** Bounded ownership reminder; settled results remain reusable after compaction. */
function buildActiveLeaseSection(sources: Iterable<PhaseLeaseSource>): string {
	const all = [...sources];
	const { activeIds, available } = dispatchCapacity(all);
	const activeLeases = formatActivePhaseLeases(all, activeIds);
	const recent = all.filter(isSettledLease).slice(-MAX_RECENT_SETTLED_LEASES).map(leaseLine).join("\n");
	if (!activeLeases && !recent) return "";
	return [
		formatDispatchSlots(available),
		...(activeLeases ? [`Active phase leases:\n${activeLeases}`] : []),
		...(recent ? [`Recent settled phases — reuse results via subagent_status; continue only unfinished work:\n${recent}`] : []),
	].join("\n");
}

/**
 * Install the directive as replaceable prompt sections. Mutating the section
 * map lets Pi diff it; returning a full `systemPrompt` would force the whole
 * prompt and drop the cached prefix.
 */
export function installDelegationSections(
	sections: Record<string, string>,
	agents: AgentConfig[],
	activeLeaseSources: Iterable<PhaseLeaseSource>,
	orchestration = "",
): void {
	const leases = buildActiveLeaseSection(activeLeaseSources);
	const stable = buildStableDelegationSection(agents, leases.length > 0);
	if (stable) sections[DELEGATION_SECTION] = stable;
	else delete sections[DELEGATION_SECTION];
	if (leases) sections[DELEGATION_LEASE_SECTION] = leases;
	else delete sections[DELEGATION_LEASE_SECTION];
	if (stable && orchestration) sections[ORCHESTRATION_SECTION] = orchestration;
	else delete sections[ORCHESTRATION_SECTION];
}
