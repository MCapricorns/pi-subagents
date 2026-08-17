/**
 * pi-subagents — focused sub-agent delegation for pi.
 *
 * Assembly point: builds the shared runtime and registers everything.
 * The heavy lifting lives in focused modules:
 *   - dispatch.ts  — the `subagent` tool (spawn, auto-fix chain, vision model)
 *   - tools.ts     — subagent_control / subagent_wait / status / stop
 *   - announcements.ts — session-start recovery and feature notices
 *   - runtime.ts       — shared per-session state
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
import { discoverAgents } from "./agents.ts";
import { registerAnnouncements } from "./announcements.ts";
import { getConfigPath, loadConfig } from "./config.ts";
import { registerSubagentTool } from "./dispatch.ts";
import { matchRunIds } from "./format.ts";
import { buildDelegationDirective } from "./prompt.ts";
import { createRuntime } from "./runtime.ts";
import { runSetup } from "./setup.ts";
import { currentSubagentDepth } from "./spawn.ts";
import { registerLookupTools } from "./tools.ts";

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

	pi.on("session_shutdown", async () => {
		await runtime.shutdown();
	});

	registerSubagentTool(pi, runtime);
	registerLookupTools(pi, runtime);

	pi.registerCommand("subagents-setup", {
		description: "Configure pi-subagents: enabled agents, primary/backup model pools, and runtime settings",
		handler: async (_args, ctx) => {
			await runSetup(ctx, configPath);
		},
	});

	registerAnnouncements(pi, runtime);

	// Proactive dispatch: inject the delegation directive into the parent system prompt.
	pi.on("before_agent_start", async (event, ctx) => {
		const config = await loadConfig(configPath);
		if (!config.proactiveInjection) return undefined;
		const { agents } = discoverAgents(ctx.cwd, {
			scope: config.agentScope,
			enabledNames: config.enabledAgents,
			projectTrusted: ctx.isProjectTrusted?.() === true,
		});
		const directive = buildDelegationDirective(agents);
		if (!directive) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n${directive}` };
	});
}
