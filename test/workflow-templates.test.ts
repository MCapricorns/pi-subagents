import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { builtinWorkflowPlans, compileBuiltinWorkflow, resolveBuiltinWorkflow } from "../src/workflow/templates.ts";
import { compileWorkflow, defaultPhaseId, renderNodeTask } from "../src/workflow/plan.ts";

const AGENTS = ["scout", "artisan", "sentinel", "skeptic"];
const MIGRATION_INPUTS = {
	TARGET: "the new cache interface",
	CONTRACT: "docs/cache-contract.md",
	CORE_CHANGE: "Replace the cache storage adapter",
	ADAPTER_CHANGE: "Update the HTTP cache callers",
	CORE_SCOPE: "src/core",
	CORE_TEST_SCOPE: "test/core",
	ADAPTER_SCOPE: "src/adapters",
	ADAPTER_TEST_SCOPE: "test/adapters",
};

describe("built-in workflows", () => {
	it("resolves only built-in names and reports the valid choices", () => {
		assert.deepEqual(builtinWorkflowPlans().map((plan) => plan.name), ["code-review", "research", "migration"]);
		assert.equal(resolveBuiltinWorkflow(" RESEARCH ", { QUESTION: "How does caching work?" }).name, "research");
		for (const name of ["custom", ".pi/workflows/research.md", "", undefined]) {
			assert.throws(() => resolveBuiltinWorkflow(name as string), /Unknown built-in workflow.*Choose code-review, research, migration/su);
		}
	});

	it("keeps independent built-in questions distinct without weakening duplicate ownership", () => {
		const first = compileBuiltinWorkflow("research", { QUESTION: "Cache invalidation" }, process.cwd(), AGENTS);
		const second = compileBuiltinWorkflow("research", { QUESTION: "Request cancellation" }, process.cwd(), AGENTS);
		const same = compileBuiltinWorkflow("research", { QUESTION: "Cache invalidation" }, process.cwd(), AGENTS);
		assert.equal(first.name, "research");
		assert.equal(first.slug, same.slug);
		assert.notEqual(first.slug, second.slug);
		for (const [index, node] of first.nodes.entries()) {
			assert.equal(defaultPhaseId(first, node), defaultPhaseId(same, same.nodes[index]!));
			assert.notEqual(defaultPhaseId(first, node), defaultPhaseId(second, second.nodes[index]!));
		}
		assert.notEqual(first.nodes.at(-1)!.task, second.nodes.at(-1)!.task);
		assert.equal(compileBuiltinWorkflow("migration", MIGRATION_INPUTS, process.cwd(), AGENTS).slug,
			compileBuiltinWorkflow("migration", Object.fromEntries(Object.entries(MIGRATION_INPUTS).reverse()), process.cwd(), AGENTS).slug);
	});

	it("substitutes literal inputs once and preserves dependency placeholders", () => {
		const question = "Compare Map<T> with <TARGET>, $& and $1";
		const first = resolveBuiltinWorkflow("research", { QUESTION: question });
		assert.ok(first.nodes.every((node) => node.task.includes(question)));
		assert.match(first.nodes.at(-1)!.task, /\{\{primary\}\}/u);
		first.nodes[0]!.task = "Changed by caller";
		const second = resolveBuiltinWorkflow("research", { QUESTION: "Another question" });
		assert.match(second.nodes[0]!.task, /Another question/u);
		assert.doesNotMatch(second.nodes[0]!.task, /Changed by caller/u);
	});

	it("keeps brace syntax in task inputs literal instead of treating it as a graph dependency", () => {
		const question = "Explain {{primary}} and \\{{unknown}} in templates";
		const graph = compileBuiltinWorkflow("research", { QUESTION: question }, process.cwd(), AGENTS);
		assert.ok(renderNodeTask(graph.nodes[0]!.task, new Map()).includes(question));
		const synthesis = graph.nodes.find((node) => node.id === "synthesis")!;
		const rendered = renderNodeTask(synthesis.task, new Map([
			["primary", { status: "completed" as const, output: "Primary evidence with \\{{literal}}" }],
			["practice", { status: "completed" as const, output: "Practice evidence" }],
			["codebase", { status: "completed" as const, output: "Repository evidence" }],
		]));
		assert.ok(rendered.includes(question));
		assert.match(rendered, /First-party:\nPrimary evidence with/u);
		assert.ok(rendered.includes("\\{{literal}}"), "upstream output must not be unescaped again");
	});

	it("validates required, misspelled, unused and invalid inputs before dispatch", () => {
		assert.throws(() => resolveBuiltinWorkflow("research"), /requires inputs: QUESTION/u);
		assert.throws(() => resolveBuiltinWorkflow("code-review", { TARGET: " " }), /non-blank string/u);
		assert.throws(() => resolveBuiltinWorkflow("code-review", { TAREGT: "HEAD" }), /Unknown workflow input "TAREGT"/u);
		assert.throws(() => resolveBuiltinWorkflow("code-review", { TARGET: "HEAD", QUESTION: "unused" }), /Unused workflow inputs: QUESTION/u);
		assert.throws(() => resolveBuiltinWorkflow("code-review", [] as unknown as Record<string, string>), /object of named strings/u);
		const { CONTRACT: _contract, ...incomplete } = MIGRATION_INPUTS;
		assert.throws(() => resolveBuiltinWorkflow("migration", incomplete), /requires inputs: CONTRACT/u);
	});

	it("uses explicit migration paths for both writers and the integrated gate", () => {
		const plan = resolveBuiltinWorkflow("migration", MIGRATION_INPUTS);
		assert.deepEqual(plan.nodes[0]!.scope?.paths, ["src/core", "test/core"]);
		assert.deepEqual(plan.nodes[1]!.scope?.paths, ["src/adapters", "test/adapters"]);
		assert.deepEqual(plan.nodes[2]!.scope?.paths, ["src/core", "test/core", "src/adapters", "test/adapters"]);
		assert.ok(plan.nodes.every((node) => node.task.includes(MIGRATION_INPUTS.CONTRACT)));
		assert.doesNotThrow(() => compileWorkflow(plan, process.cwd(), AGENTS));
		assert.throws(() => compileWorkflow(resolveBuiltinWorkflow("migration", {
			...MIGRATION_INPUTS, ADAPTER_SCOPE: "src/core/adapter",
		}), process.cwd(), AGENTS), /overlap/u);
		assert.throws(() => compileWorkflow(resolveBuiltinWorkflow("migration", {
			...MIGRATION_INPUTS, CORE_SCOPE: "src/*",
		}), process.cwd(), AGENTS), /wildcard/u);
	});

	it("keeps review and research ready for the compiler without a second template review", () => {
		const review = resolveBuiltinWorkflow("code-review", { TARGET: "HEAD~1..HEAD" });
		assert.equal(review.nodes.length, 1);
		assert.equal(review.nodes[0]!.agent, "sentinel");
		assert.doesNotThrow(() => compileWorkflow(review, process.cwd(), AGENTS));
		const research = resolveBuiltinWorkflow("research", { QUESTION: "Cache behavior" });
		assert.equal(research.nodes.length, 4);
		assert.doesNotThrow(() => compileWorkflow(research, process.cwd(), AGENTS));
	});
});
