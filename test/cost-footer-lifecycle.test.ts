import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	createExtensionRuntime,
	ExtensionRunner,
	SessionManager,
	type Extension,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { clearCostFooter, installCostFooter } from "../src/presentation/cost-footer.ts";
import { costLedger, registerMainCostTracking, seedCostLedgerFromSession } from "../src/presentation/cost-ledger.ts";

const plainTheme = { fg: (_color: string, text: string) => text } as Theme;
type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;

function createSession(cwd: string) {
	const state = {
		model: { provider: "test", id: "original", reasoning: true } as NonNullable<ExtensionContext["model"]>,
		thinkingLevel: "high" as ExtensionContext["thinkingLevel"],
		usage: { tokens: 25_000, contextWindow: 200_000, percent: 12.5 },
		renderRequests: 0,
	};
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as ExtensionAPI;
	registerMainCostTracking(pi);
	pi.on("session_start", async (_event, ctx) => {
		seedCostLedgerFromSession(ctx);
		installCostFooter(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => clearCostFooter(ctx));

	const sessionManager = SessionManager.inMemory(cwd);
	const runner = new ExtensionRunner(
		[{ path: import.meta.filename, handlers } as Extension],
		createExtensionRuntime(),
		cwd,
		sessionManager,
		{} as ConstructorParameters<typeof ExtensionRunner>[4],
	);
	runner.onError((error) => { throw new Error(error.error); });
	runner.bindCore(
		{ getThinkingLevel: () => state.thinkingLevel } as Parameters<ExtensionRunner["bindCore"]>[0],
		{
			getModel: () => state.model,
			getContextUsage: () => state.usage,
		} as Parameters<ExtensionRunner["bindCore"]>[1],
	);

	let footer: ReturnType<FooterFactory> | undefined;
	const branchListeners = new Set<() => void>();
	runner.setUIContext({
		...runner.getUIContext(),
		setFooter(factory) {
			footer?.dispose?.();
			footer = factory?.(
				{ requestRender: () => { state.renderRequests++; } } as Parameters<FooterFactory>[0],
				plainTheme,
				{
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map(),
					getAvailableProviderCount: () => 1,
					onBranchChange(callback) {
						branchListeners.add(callback);
						return () => { branchListeners.delete(callback); };
					},
				},
			);
		},
	}, "tui");
	return {
		runner, sessionManager, state, branchListeners,
		render() {
			assert.ok(footer, "the session must have an installed footer");
			return footer.render(160);
		},
	};
}

describe("cost footer session lifecycle", () => {
	afterEach(() => costLedger.reset());

	for (const reason of ["reload", "new", "resume", "fork"] as const) {
		it(`renders the replacement session before any cost event after ${reason}`, async (t) => {
			const previous = createSession("/previous-project");
			await previous.runner.emit({ type: "session_start", reason: "startup" });
			await previous.runner.emit({
				type: "message_start",
				message: { role: "user", content: "Hello", timestamp: 0 },
			});
			assert.match(previous.render()[1]!, /test\/original/u);

			await previous.runner.emit({ type: "session_shutdown", reason });
			assert.equal(previous.branchListeners.size, 0);
			const requests = previous.state.renderRequests;
			costLedger.record("test/original", { cost: 5 });
			assert.equal(previous.state.renderRequests, requests, "shutdown must unsubscribe ledger renders");
			previous.runner.invalidate();
			assert.throws(() => previous.runner.createContext().sessionManager, /ctx is stale/u);

			// Keep the imported ledger module, as Pi's loader can across replacements.
			const next = createSession("/replacement-project");
			t.after(() => next.runner.emit({ type: "session_shutdown", reason: "quit" }));
			next.state.model = { ...next.state.model, id: "replacement" };
			next.sessionManager.appendSessionInfo("Replacement session");
			await next.runner.emit({ type: "session_start", reason });
			const lines = next.render();
			assert.match(lines[0]!, /replacement-project \(main\) • Replacement session$/u);
			assert.match(lines[1]!, /\$0\.0000 .*test\/replacement • high$/u);
			assert.ok(!lines.join("\n").includes("test/original"));
		});
	}

	it("keeps model, thinking, context usage, and session name live within the owning session", async (t) => {
		const session = createSession("/live-project");
		t.after(() => session.runner.emit({ type: "session_shutdown", reason: "quit" }));
		await session.runner.emit({ type: "session_start", reason: "startup" });
		await session.runner.emit({ type: "model_select", model: session.state.model, previousModel: undefined, source: "restore" });
		assert.match(session.render()[1]!, /12\.5%\/200\.0k .*test\/original • high$/u);

		const previousModel = session.state.model;
		session.state.model = { ...previousModel, id: "selected" };
		await session.runner.emit({ type: "model_select", model: session.state.model, previousModel, source: "set" });
		session.state.thinkingLevel = "low";
		session.state.usage.percent = 37.5;
		session.sessionManager.appendSessionInfo("Renamed session");
		const lines = session.render();
		assert.match(lines[0]!, /live-project \(main\) • Renamed session$/u);
		assert.match(lines[1]!, /37\.5%\/200\.0k .*test\/selected • low$/u);
		assert.equal(session.branchListeners.size, 1);
	});
});
