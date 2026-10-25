/**
 * Live workflow graph state shared by the runner, the status tool, and the
 * runtime. Kept free of behaviour so the runtime can hold it without importing
 * the engine.
 */

import type { PhaseScope } from "../delegation/phase-scope.ts";
import type { SingleResult } from "../execution/spawn.ts";
import type { RecordedNodeState } from "./durable.ts";

export type WorkflowNodeState = RecordedNodeState;

export interface WorkflowNodeRun {
	id: string;
	index: number;
	agent: string;
	/** Authored brief, still carrying its result placeholders. */
	task: string;
	/** Brief actually sent, after upstream interpolation. */
	dispatchedTask?: string;
	dependsOn: string[];
	phaseId: string;
	scope?: PhaseScope;
	cwd: string;
	state: WorkflowNodeState;
	runId?: number;
	startedAt?: number;
	endedAt?: number;
	result?: SingleResult;
	error?: string;
}

export type WorkflowRunState = "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface WorkflowRun {
	id: number;
	name: string;
	slug: string;
	description?: string;
	cwd: string;
	state: WorkflowRunState;
	stopReason?: string;
	startedAt: number;
	endedAt?: number;
	nodes: WorkflowNodeRun[];
	/** Aborts the graph's waiters; node processes are stopped individually. */
	controller: AbortController;
}
