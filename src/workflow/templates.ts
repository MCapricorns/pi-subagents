/** Built-in workflow plans and their explicit input slots. Runtime policy lives
 * in the compiler/runner; templates contain only task-specific briefs. */

import { createHash } from "node:crypto";
import { compileWorkflow, type CompiledWorkflow, type WorkflowPlanInput } from "./plan.ts";

export const WORKFLOW_INPUT_KEYS = [
	"QUESTION", "TARGET", "CONTRACT", "CORE_CHANGE", "ADAPTER_CHANGE",
	"CORE_SCOPE", "CORE_TEST_SCOPE", "ADAPTER_SCOPE", "ADAPTER_TEST_SCOPE",
] as const;

const INPUT_PATTERN = new RegExp(`<(${WORKFLOW_INPUT_KEYS.join("|")})>`, "gu");

/** Each lookup returns a fresh plan so customizing one dispatch cannot mutate
 * the catalog used by the next dispatch. */
export function builtinWorkflowPlans(): WorkflowPlanInput[] {
	return [
		{
			name: "code-review",
			description: "Inspect a target change; the required acceptance review checks the findings and evidence.",
			nodes: [{
				id: "review",
				agent: "sentinel",
				task: "Review <TARGET> against the stated requirements and relevant callers. Establish the diff once, then inspect correctness, regressions, compatibility, and concrete failure paths within that target. Reuse existing research and valid checks; run a focused reproduction only to resolve a suspected defect. Stay read-only and do not change Git state. Return confirmed actionable findings with path:line, trigger, consequence, evidence, and smallest fix; include checks and material gaps. State clearly if no confirmed findings were found. The final acceptance officer will verify the report and its evidence; do not add another general review.",
			}],
		},
		{
			name: "research",
			description: "Research a question from independent angles, synthesize an answer, and submit its evidence for acceptance.",
			nodes: [
				{
					id: "primary",
					agent: "scout",
					task: "Research <QUESTION> from first-party sources only: official documentation, specifications, release notes, and the project's own repository. Record versions and dates. Cite every fact you state. Mark anything you could only find second-hand.",
				},
				{
					id: "practice",
					agent: "scout",
					task: "Research <QUESTION> from practice: issue threads, migration notes, benchmarks, and post-mortems that describe what actually happened when people used it. Separate reported experience from vendor claims and cite each source.",
				},
				{
					id: "codebase",
					agent: "scout",
					task: "Establish what this repository already does about <QUESTION>: the relevant modules, configuration, and tests, with path:line citations. State where the code disagrees with the documentation if you find such a place.",
				},
				{
					id: "synthesis",
					agent: "scout",
					dependsOn: ["primary", "practice", "codebase"],
					task: "Answer <QUESTION> from these three research passes. Reconcile disagreements explicitly; check dates, versions, and conditions when official claims conflict with observed practice. Prefer evidence applicable to this question.\n\nFirst-party:\n{{primary}}\n\nPractice:\n{{practice}}\n\nThis repository:\n{{codebase}}\n\nReturn the answer, decisive citations, open questions, and what would change the answer. The final acceptance officer checks the answer and its evidence.",
				},
			],
		},
		{
			name: "migration",
			description: "Apply two planned migration slices, run their integrated gate, and submit the result for acceptance.",
			nodes: [
				{
					id: "apply-core",
					agent: "artisan",
					task: "Migrate the core slice to <TARGET>. <CORE_CHANGE>. Interface contract: <CONTRACT>. Follow the declared write scope. Implement the change and its regression tests together; run the relevant checks. Report changed paths, command results, and blockers. If the plan conflicts with the code or requires another slice's files, stop and report evidence instead of inventing a new scope.",
					scope: { paths: ["<CORE_SCOPE>", "<CORE_TEST_SCOPE>"] },
				},
				{
					id: "apply-adapters",
					agent: "artisan",
					task: "Migrate the adapter slice to <TARGET>. <ADAPTER_CHANGE>. Interface contract: <CONTRACT>. Follow the declared write scope. Implement the change and its regression tests together; run the relevant checks. Report changed paths, command results, and blockers. If the plan conflicts with the code or requires another slice's files, stop and report evidence instead of inventing a new scope.",
					scope: { paths: ["<ADAPTER_SCOPE>", "<ADAPTER_TEST_SCOPE>"] },
				},
				{
					id: "gate",
					agent: "artisan",
					dependsOn: ["apply-core", "apply-adapters"],
					task: "Run the project's documented required checks on the integrated migration to <TARGET>. Interface contract: <CONTRACT>. Verify both slices meet their done conditions; report missing prerequisites instead of guessing. Reuse valid checks on unchanged code and inspect cross-slice callers for mismatches. Fix failures caused by the migration within its declared scope. Report commands, results, and unverified risks. The final acceptance officer independently checks the result.\n\nCore:\n{{apply-core}}\n\nAdapters:\n{{apply-adapters}}",
					scope: { paths: ["<CORE_SCOPE>", "<CORE_TEST_SCOPE>", "<ADAPTER_SCOPE>", "<ADAPTER_TEST_SCOPE>"] },
				},
			],
		},
	];
}

/** Resolve only a shipped plan. There is no filesystem discovery and callers
 * cannot replace the graph, its roles, or the acceptance policy. */
export function resolveBuiltinWorkflow(
	name: string,
	inputs: Record<string, string> = {},
): WorkflowPlanInput {
	const plans = builtinWorkflowPlans();
	const plan = typeof name === "string" ? plans.find((entry) => entry.name === name.trim().toLowerCase()) : undefined;
	if (!plan) {
		throw new Error(`Unknown built-in workflow "${String(name ?? "")}". Choose ${plans.map((entry) => entry.name).join(", ")}. No nodes were started.`);
	}
	return fillWorkflowTemplate(plan, inputs);
}

/** Different built-in inputs own different phases; the same deliverable keeps
 * its identity across repeated calls. Display names remain short and stable. */
export function compileBuiltinWorkflow(
	name: string,
	inputs: Record<string, string> | undefined,
	cwd: string,
	knownAgents: readonly string[],
): CompiledWorkflow {
	const plan = resolveBuiltinWorkflow(name, inputs);
	const identity = createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 12);
	const workflow = compileWorkflow(plan, cwd, knownAgents);
	workflow.slug = `${workflow.slug}-${identity}`;
	for (const node of workflow.nodes) {
		// Pending phases also match exact task text. Acceptance must distinguish
		// two questions even before their evidence briefs have been built.
		if (node.kind === "acceptance") node.task += `\n\nDeliverable identity: ${workflow.slug}`;
	}
	return workflow;
}

/** Fill only explicit template slots, in one pass. Ordinary code such as <T>
 * and graph result placeholders {{id}} keep their original meaning. Unknown or
 * unused inputs are errors so a misspelled scope cannot silently change a plan. */
function fillWorkflowTemplate(
	plan: WorkflowPlanInput,
	inputs: Record<string, string> = {},
): WorkflowPlanInput {
	if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
		throw new Error("Workflow inputs must be an object of named strings. No nodes were started.");
	}
	for (const [key, value] of Object.entries(inputs)) {
		if (!(WORKFLOW_INPUT_KEYS as readonly string[]).includes(key)) {
			throw new Error(`Unknown workflow input "${key}". Available inputs: ${WORKFLOW_INPUT_KEYS.join(", ")}. No nodes were started.`);
		}
		if (typeof value !== "string" || !value.trim()) {
			throw new Error(`Workflow input "${key}" must be a non-blank string. No nodes were started.`);
		}
	}
	const used = new Set<string>();
	const missing = new Set<string>();
	const fill = (value: string, literalTask = false): string => value.replace(INPUT_PATTERN, (slot, key: string) => {
		used.add(key);
		if (!Object.hasOwn(inputs, key)) { missing.add(key); return slot; }
		return literalTask ? inputs[key]!.replace(/\{\{/gu, "\\{{") : inputs[key]!;
	});
	const next: WorkflowPlanInput = {
		...plan,
		nodes: plan.nodes.map((node) => ({
			...node,
			task: fill(node.task, true),
			...(node.scope ? { scope: {
				...node.scope,
				paths: node.scope.paths?.map((path) => fill(path)),
			} } : {}),
		})),
	};
	if (missing.size) throw new Error(`Workflow "${plan.name}" requires inputs: ${[...missing].join(", ")}. No nodes were started.`);
	const unused = Object.keys(inputs).filter((key) => !used.has(key));
	if (unused.length) throw new Error(`Unused workflow inputs: ${unused.join(", ")}. No nodes were started.`);
	return next;
}
