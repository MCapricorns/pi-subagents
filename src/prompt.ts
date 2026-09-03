/**
 * Builds the delegation directive injected into the parent model's
 * system prompt via `before_agent_start`. It is paid on every turn, so it
 * stays a lean routing, phase-ownership, and verification contract.
 * Detailed role guidance remains in each child's own prompt.
 */

import { resolve } from "node:path";
import type { AgentConfig } from "./agents.ts";
import { formatCatalogEntry } from "./agents.ts";

export interface PhaseLeaseSource {
	id: number;
	agentName: string;
	task: string;
	cwd: string;
	state: "queued" | "resuming" | "running" | "interrupting" | "parked" | "completed" | "failed" | "stopped";
	lifecycleOperation?: "park" | "resume" | "stop" | "settle";
}

const ACTIVE_LEASE_STATES = new Set<PhaseLeaseSource["state"]>([
	"queued",
	"resuming",
	"running",
	"interrupting",
	"parked",
]);
const MAX_ACTIVE_LEASES = 2;
const MAX_LEASE_TASK_LENGTH = 56;

function bullets(lines: readonly string[]): string {
	return lines.map((line) => `- ${line}`).join("\n");
}

function phaseForAgent(agentName: string): string {
	if (agentName === "scout") return "broad reconnaissance";
	if (agentName === "artisan") return "implementation and targeted checks";
	if (agentName === "steward") return "pre-commit cleanup and cross-cutting docs";
	return "delegated scope";
}

function isActivePhaseLease(source: PhaseLeaseSource): boolean {
	return source.lifecycleOperation === "settle" || ACTIVE_LEASE_STATES.has(source.state);
}

function normalizedTask(task: string): string {
	return task.replace(/\s+/gu, " ").trim();
}

function normalizedCwd(cwd: string): string {
	const resolved = resolve(cwd);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function findDuplicateActiveDispatch(
	sources: Iterable<PhaseLeaseSource>,
	task: string,
	cwd: string,
): PhaseLeaseSource | undefined {
	const taskKey = normalizedTask(task);
	const cwdKey = normalizedCwd(cwd);
	return [...sources].find((source) =>
		isActivePhaseLease(source) &&
		normalizedTask(source.task) === taskKey &&
		normalizedCwd(source.cwd) === cwdKey,
	);
}

function summarizeLeaseTask(task: string): string {
	const oneLine = normalizedTask(task);
	const characters = [...oneLine];
	return characters.length <= MAX_LEASE_TASK_LENGTH
		? oneLine
		: `${characters.slice(0, MAX_LEASE_TASK_LENGTH - 1).join("")}…`;
}

function formatActivePhaseLeases(sources: Iterable<PhaseLeaseSource>): string {
	const active = [...sources].filter(isActivePhaseLease);
	if (active.length === 0) return "";
	const lines = active.slice(0, MAX_ACTIVE_LEASES).map((source) => {
		const state = source.lifecycleOperation === "settle" ? "settling" : source.state;
		return `- #${source.id} ${phaseForAgent(source.agentName)} (${source.agentName}, ${state}): ${summarizeLeaseTask(source.task)}`;
	});
	if (active.length > MAX_ACTIVE_LEASES) {
		lines.push(`- … ${active.length - MAX_ACTIVE_LEASES} more active lease${active.length - MAX_ACTIVE_LEASES === 1 ? "" : "s"} omitted`);
	}
	return lines.join("\n");
}

export function formatPhaseLeaseReceipt(sources: Iterable<PhaseLeaseSource>): string {
	const leases = formatActivePhaseLeases(sources);
	if (!leases) return "";
	return `Active phase lease:\n${leases}\nDo not duplicate it; continue only disjoint work.`;
}

export function buildDelegationDirective(
	agents: AgentConfig[],
	activeLeaseSources: Iterable<PhaseLeaseSource> = [],
): string {
	const activeLeases = formatActivePhaseLeases(activeLeaseSources);
	if (agents.length === 0 && !activeLeases) return "";

	const catalog = agents.length > 0 ? agents.map(formatCatalogEntry).join("\n") : "- (none enabled)";
	const hasScout = agents.some((agent) => agent.name === "scout");
	const hasArtisan = agents.some((agent) => agent.name === "artisan");
	const hasSteward = agents.some((agent) => agent.name === "steward");

	const dispatchRules = [
		"Main owns routing, architecture, integration, the final gate, and release. Each child starts a paid context; delegate only when saved main-context work exceeds handoff cost.",
		"Keep atomic lookups, focused edits, known answers, and context-heavy work in main. Cluster related reconnaissance into one scout brief.",
		...(hasScout ? ["`scout`: broad or unfamiliar reconnaissance; return compact findings and decisive citations."] : []),
		...(hasArtisan ? ["`artisan`: substantial self-contained implementation, including affected tests, docs, comments, and targeted checks."] : []),
		...(hasSteward ? ["`steward`: one pre-commit cleanup or cross-cutting docs/comments pass for a completed broad or multi-writer change; keep small diff hygiene inline."] : []),
		"One owner per phase; dependent phases wait. A launch leases that phase: main may inspect its result, citations, diff, and check output but must not rerun it.",
		"Parallelize only independently justified, disjoint scopes. Brief goal, scope, constraints, and expected output; resume retained work with `subagent_control`.",
		"Completions deliver automatically. Never poll, restate a result, or finish while a run is active.",
		"Inspect the integrated diff and actual check output. Never report an unrun check as passed.",
	];

	return `
## Sub-agent delegation

Agents:
${catalog}

Rules:
${bullets(dispatchRules)}${activeLeases ? `

Active phase leases:
${activeLeases}` : ""}`;
}
