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
	if (agentName === "artisan") return "primary change";
	if (agentName === "steward") return "pre-commit cleanup and cross-cutting docs";
	if (agentName === "sentinel") return "post-cleanup adversarial review";
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
	const hasSentinel = agents.some((agent) => agent.name === "sentinel");

	const dispatchRules = [
		`Main owns routing, architecture, integration, the final gate, and release. Each child starts a paid context; delegate only when handoff saves more than it costs${hasSentinel ? ", except required sentinel review before commit" : ""}.`,
		"Keep atomic lookups, focused edits, known answers, and context-heavy work in main. Cluster related reconnaissance into one scout brief, including external research.",
		...(hasScout ? ["`scout`: read-only broad code mapping or external research; return file/source citations as leads, not proof."] : []),
		...(hasArtisan ? ["`artisan`: one substantial primary change; own root cause, implementation, affected tests/docs, and targeted checks."] : []),
		...(hasSteward ? ["`steward`: final cleanup/docs sync for a completed broad or multi-writer diff; keep focused hygiene inline."] : []),
		...(hasSentinel ? ["`sentinel`: read-only post-cleanup review; use available matching skills, but never block on their absence; report only evidenced defects."] : []),
		...(hasSentinel
			? [`Before every commit: cleanup -> sentinel review. ${hasSteward ? "Use steward once only for broad or multi-writer diffs" : "Keep cleanup inline"}. Then dispatch sentinel on the final diff and check evidence. After review fixes, clean and review once more; findings block commit.`]
			: []),
		"One owner per phase; dependent phases wait. A launch leases that phase: main may inspect its result, citations, diff, and checks, not redo the phase; main still runs the final gate.",
		"Parallelize only independent, disjoint scopes. Brief goal, paths, constraints, and expected output; resume with `subagent_control`.",
		"`wait: true` only when the result is the immediate dependency; otherwise continue disjoint work. Never sleep or poll, and never finish while a run is active.",
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
