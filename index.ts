/**
 * pi-subagents — focused sub-agent delegation for pi.
 *
 * Assembly point: builds the shared runtime and registers everything.
 * The heavy lifting lives in focused modules:
 *   - delegation/    — built-in roles, routing prompts, and tool contract
 *   - configuration/ — persisted settings, model routes, and setup UI
 *   - execution/     — background tasks, native RPC transport, and model handoff
 *   - lifecycle/     — durable threads, restoration, controls, and delivery
 *   - workflow/      — built-in plans, dependency runner, and acceptance
 *   - isolation/     — Git worktrees, recovery, and temporary-state hygiene
 *   - presentation/  — announcements, formatting, monitor, and the active-run
 *     widget
 *
 * Also registers the `/subagents-setup` command and a `before_agent_start` hook
 * that installs the delegation directive as replaceable prompt sections so the
 * main model can choose useful, self-contained work to delegate.
 *
 * The tool is not registered inside child sub-agent processes, which prevents
 * runaway recursion and keeps child context windows clean.
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getConfigPath } from "./src/configuration/config.ts";
import { runSetup } from "./src/configuration/setup.ts";
import { loadBuiltinAgents } from "./src/delegation/agents.ts";
import { registerSubagentTool } from "./src/delegation/dispatch.ts";
import { buildDelegationDirective, installDelegationSections } from "./src/delegation/prompt.ts";
import { pendingWorkflowLeases, registerMainOwnershipGuard } from "./src/delegation/ownership.ts";
import { currentSubagentDepth } from "./src/execution/spawn.ts";
import { createDispatchCore } from "./src/lifecycle/dispatch-core.ts";
import { registerCancellationHooks } from "./src/lifecycle/cancellation.ts";
import { createRuntime } from "./src/lifecycle/runtime.ts";
import { bootstrapDurableState } from "./src/lifecycle/thread-restore.ts";
import { registerLookupTools } from "./src/lifecycle/tools.ts";
import { registerWorkflowTool, restoreWorkflowState } from "./src/workflow/tool.ts";
import { registerAnnouncements } from "./src/presentation/announcements.ts";
import { clearActiveRunsWidget } from "./src/presentation/widget.ts";
import { formatBytes, measureDurableUsage, runStorageCleanup } from "./src/isolation/cleanup.ts";
import { getSubagentsRoot } from "./src/execution/spawn.ts";

export default function (pi: ExtensionAPI): void {
	// Recursion guard: sub-agent children are leaf processes. The `subagent` tool is
	// excluded from their toolset at spawn (--exclude-tools); this check is defense
	// in depth so a child can never expose the tool back to its model, even if
	// another extension ignores the depth marker.
	if (currentSubagentDepth() >= 1) {
		pi.registerCommand("subagents-setup", {
			description: "Configure pi-subagents (unavailable in nested sub-agent processes)",
			handler: async (_args, ctx) => {
				ctx.ui.notify("pi-subagents setup is unavailable in nested sub-agent processes.", "warning");
			},
		});
		return;
	}

	const configPath = getConfigPath(getAgentDir());
	const runtime = createRuntime(pi, configPath);

	pi.registerMessageRenderer("subagent-result", (message, _options, theme) =>
		new Text(
			`${theme.fg("toolTitle", theme.bold("subagent result"))}\n${message.content}`,
			0,
			0,
		),
	);

	pi.on("session_shutdown", async (_event, ctx) => {
		clearActiveRunsWidget(ctx);
		await runtime.shutdown();
	});

	// One dispatcher serves both delegation tools, so a workflow node is an
	// ordinary managed run: same lifecycle ownership, admission, isolation, and
	// durable checkpointing.
	const dispatchCore = createDispatchCore(runtime);
	registerSubagentTool(pi, runtime, dispatchCore);
	registerWorkflowTool(pi, runtime, dispatchCore);
	registerLookupTools(pi, runtime, dispatchCore);
	registerCancellationHooks(pi, runtime);
	registerMainOwnershipGuard(pi, runtime);

	pi.registerCommand("subagents-setup", {
		description: "Configure pi-subagents: model and thinking per role",
		handler: async (_args, ctx) => {
			await runSetup(ctx, configPath);
		},
	});

	pi.registerCommand("subagents-cleanup", {
		description: "Report and reclaim pi-subagents storage; /subagents-cleanup dry-run only reports",
		handler: async (args, ctx) => {
			const root = getSubagentsRoot(configPath);
			if (args.trim() === "dry-run") {
				const usage = measureDurableUsage(root);
				const detail = usage.projects.slice(0, 5).map((project) =>
					`${project.path.split(/[\\/]/u).at(-1)} ${formatBytes(project.bytes)} (${project.sessions} sessions, ${project.worktrees} worktrees)`);
				ctx.ui.notify(`pi-subagents storage: ${formatBytes(usage.totalBytes)} in ${usage.projects.length} project(s)${detail.length ? " · " + detail.join(" · ") : ""}.`, "info");
				return;
			}
			const result = await runStorageCleanup(configPath);
			ctx.ui.notify(
				`pi-subagents cleanup: freed ${formatBytes(result.freedBytes)} (${formatBytes(result.before.totalBytes)} → ${formatBytes(result.after.totalBytes)})`
				+ `${result.removedProjects.length ? `; removed ${result.removedProjects.length} idle project root${result.removedProjects.length === 1 ? "" : "s"}` : ""}`
				+ `; kept ${result.parkedRecords} parked recovery record${result.parkedRecords === 1 ? "" : "s"} and every referenced artifact.`,
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await bootstrapDurableState(runtime, ctx.cwd);
		await restoreWorkflowState(runtime, ctx);
	});
	registerAnnouncements(pi, runtime);

	// Install the routing contract as prompt sections when the host can diff them.
	// A full systemPrompt return forces an opaque prompt and invalidates the cache.
	pi.on("before_agent_start", async (event) => {
		await runtime.durableRestore;
		const agents = loadBuiltinAgents();
		const sources = [...runtime.threads.values(), ...pendingWorkflowLeases(runtime)];
		const sections = event.systemPromptOptions?.sections;
		if (sections) {
			installDelegationSections(sections, agents, sources);
			return undefined;
		}
		const directive = buildDelegationDirective(agents, sources);
		if (!directive) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n${directive}` };
	});
}
