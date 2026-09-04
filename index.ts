/**
 * pi-subagents — focused sub-agent delegation for pi.
 *
 * Assembly point: builds the shared runtime and registers everything.
 * The heavy lifting lives in focused modules:
 *   - delegation/    — role discovery, routing prompts, and tool contract
 *   - configuration/ — persisted settings, model routes, and setup UI
 *   - execution/     — process queue, RPC transport/control, and model handoff
 *   - lifecycle/     — durable threads, restoration, controls, and delivery
 *   - isolation/     — Git worktrees, recovery, and temporary-state hygiene
 *   - presentation/  — announcements, formatting, monitor, status, and widget
 *
 * Also registers the `/subagents-setup` command and a `before_agent_start` hook
 * that injects a delegation directive into the parent system prompt so the main
 * model uses the tool proactively.
 *
 * The tool is not registered inside child sub-agent processes, which prevents
 * runaway recursion and keeps child context windows clean.
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getConfigPath, loadConfig } from "./src/configuration/config.ts";
import { runSetup } from "./src/configuration/setup.ts";
import { discoverAgents } from "./src/delegation/agents.ts";
import { registerSubagentTool } from "./src/delegation/dispatch.ts";
import { registerSubagentRiskTool } from "./src/delegation/risk.ts";
import { buildDelegationDirective } from "./src/delegation/prompt.ts";
import { currentSubagentDepth } from "./src/execution/spawn.ts";
import { createRuntime } from "./src/lifecycle/runtime.ts";
import { bootstrapDurableState } from "./src/lifecycle/thread-restore.ts";
import { registerLookupTools } from "./src/lifecycle/tools.ts";
import { registerAnnouncements } from "./src/presentation/announcements.ts";
import { matchRunIds } from "./src/presentation/format.ts";
import { clearActiveRunsStatus } from "./src/presentation/status.ts";
import { clearActiveRunsWidget } from "./src/presentation/widget.ts";

export { matchRunIds };

export default function (pi: ExtensionAPI): void {
	const configPath = getConfigPath(getAgentDir());
	const runtime = createRuntime(pi, configPath);

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

	pi.registerMessageRenderer("subagent-result", (message, _options, theme) =>
		new Text(
			`${theme.fg("toolTitle", theme.bold("subagent result"))}\n${message.content}`,
			0,
			0,
		),
	);

	pi.on("session_shutdown", async (_event, ctx) => {
		clearActiveRunsStatus(ctx);
		clearActiveRunsWidget(ctx);
		await runtime.shutdown();
	});

	registerSubagentTool(pi, runtime);
	registerSubagentRiskTool(pi);
	registerLookupTools(pi, runtime);

	pi.registerCommand("subagents-setup", {
		description: "Configure pi-subagents: agents, models, and per-role thinking",
		handler: async (_args, ctx) => {
			await runSetup(ctx, configPath);
		},
	});

	pi.on("session_start", async () => {
		await bootstrapDurableState(runtime);
	});
	registerAnnouncements(pi, runtime);

	// Inject the routing contract plus bounded live phase leases into each parent turn.
	pi.on("before_agent_start", async (event, ctx) => {
		await runtime.durableRestore;
		const config = await loadConfig(configPath);
		const { agents } = discoverAgents(ctx.cwd, {
			scope: config.agentScope,
			enabledNames: config.enabledAgents,
			projectTrusted: ctx.isProjectTrusted?.() === true,
		});
		const directive = buildDelegationDirective(agents, runtime.threads.values());
		if (!directive) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n${directive}` };
	});
}
