/**
 * Per-model spend ledger for the main window's own generation.
 *
 * Sub-agent runs are deliberately not tracked here: every child reports its
 * usage with its model ref when it settles (completion block, widget row,
 * per-model completion totals), so mixing its live spend into the parent's
 * footer would just re-create the cross-model sum this ledger exists to
 * avoid. The ledger covers the main window only — across `/model` switches,
 * each model keeps its own tally — plus its live token throughput.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelRef } from "../configuration/models.ts";

export interface ModelSpend {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface ModelSpendRow {
	/** Full `provider/model` ref. */
	model: string;
	/** True while this is the window's current model. */
	current: boolean;
	spend: ModelSpend;
}

export interface MainStreamSpeed {
	model: string;
	tokensPerSecond: number;
	/** True while the assistant is still streaming (value is an estimate). */
	streaming: boolean;
}

interface StreamState {
	model: string;
	startedAt: number;
	estimatedChars: number;
}

/** Rough chars-per-token for the live estimate; the exact rate replaces it at
 * `message_end`, where real output tokens are known. */
const ESTIMATED_CHARS_PER_TOKEN = 4;

/** pi Usage shape: numeric token buckets plus a cost that is either already a
 * number (child tallies) or the provider object with a `total`. */
interface UsageLike {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: unknown;
}

function emptySpend(): ModelSpend {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** `provider/model` for a message; falls back to the bare model id when a
 * providerless message sneaks through. */
export function messageModelRef(message: { provider?: string; model?: string }): string | undefined {
	const model = message.model?.trim();
	if (!model) return undefined;
	return message.provider?.trim() ? `${message.provider.trim()}/${model}` : model;
}

function finiteUsage(usage: UsageLike | undefined): ModelSpend {
	const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	const cost = usage?.cost;
	return {
		input: num(usage?.input),
		output: num(usage?.output),
		cacheRead: num(usage?.cacheRead),
		cacheWrite: num(usage?.cacheWrite),
		cost: num(typeof cost === "object" && cost !== null ? (cost as { total?: unknown }).total : cost),
	};
}

export class CostLedger {
	private rows = new Map<string, ModelSpend>();
	/** First-seen order, so row order is stable between notifications. */
	private order: string[] = [];
	private currentModel: string | undefined;
	private stream: StreamState | undefined;
	private lastSpeed: MainStreamSpeed | undefined;
	private subscribers = new Set<() => void>();

	record(model: string, spend: UsageLike | undefined): void {
		const ref = model.trim();
		if (!ref) return;
		const row = this.rows.get(ref) ?? emptySpend();
		const add = finiteUsage(spend);
		row.input += add.input;
		row.output += add.output;
		row.cacheRead += add.cacheRead;
		row.cacheWrite += add.cacheWrite;
		row.cost += add.cost;
		if (!this.rows.has(ref)) this.order.push(ref);
		this.rows.set(ref, row);
		this.notify();
	}

	markCurrentModel(model: string | undefined): void {
		const ref = model?.trim() || undefined;
		if (ref === this.currentModel) return;
		this.currentModel = ref;
		this.notify();
	}

	getCurrentModel(): string | undefined {
		return this.currentModel;
	}

	/** Current model first, everything else in first-seen order. A current
	 * model with no spend yet still gets a zero row so the footer keeps its
	 * shape from the first render. */
	snapshot(): ModelSpendRow[] {
		const rows: ModelSpendRow[] = [];
		if (this.currentModel) {
			rows.push({ model: this.currentModel, current: true, spend: this.rows.get(this.currentModel) ?? emptySpend() });
		}
		for (const model of this.order) {
			if (model === this.currentModel) continue;
			rows.push({ model, current: false, spend: this.rows.get(model) ?? emptySpend() });
		}
		return rows;
	}

	reset(): void {
		this.rows.clear();
		this.order = [];
		this.currentModel = undefined;
		this.stream = undefined;
		this.lastSpeed = undefined;
		this.notify();
	}

	subscribe(cb: () => void): () => void {
		this.subscribers.add(cb);
		return () => {
			this.subscribers.delete(cb);
		};
	}

	noteStreamStart(model: string): void {
		this.stream = { model, startedAt: Date.now(), estimatedChars: 0 };
		this.lastSpeed = undefined;
		this.notify();
	}

	noteStreamDelta(chars: number): void {
		if (!this.stream || chars <= 0) return;
		this.stream.estimatedChars += chars;
		this.notify();
	}

	isStreaming(): boolean {
		return this.stream !== undefined;
	}

	noteStreamEnd(model: string, outputTokens: number): void {
		const stream = this.stream;
		this.stream = undefined;
		if (stream && outputTokens > 0) {
			const seconds = Math.max(0.001, (Date.now() - stream.startedAt) / 1_000);
			this.lastSpeed = { model, tokensPerSecond: outputTokens / seconds, streaming: false };
		}
		this.notify();
	}

	/** Live estimate while streaming, exact rate of the last completed
	 * assistant message afterwards; undefined before any generation. */
	speed(): MainStreamSpeed | undefined {
		if (this.stream) {
			const seconds = Math.max(0.001, (Date.now() - this.stream.startedAt) / 1_000);
			return {
				model: this.stream.model,
				tokensPerSecond: this.stream.estimatedChars / ESTIMATED_CHARS_PER_TOKEN / seconds,
				streaming: true,
			};
		}
		return this.lastSpeed;
	}

	private notify(): void {
		for (const cb of this.subscribers) {
			try {
				cb();
			} catch {
				/* subscriber errors must not break accounting */
			}
		}
	}
}

export const costLedger = new CostLedger();

/** Latest event context, so the footer renders against live session state
 * (context usage, cwd, session name) without holding a stale install-time ctx. */
let latestContext: ExtensionContext | undefined;

/** Wire the main window's own generation into the ledger: assistant messages
 * carry the serving model and exact usage, model switches re-key the current
 * row, and compaction calls land on the model that made them. */
export function registerMainCostTracking(pi: ExtensionAPI): void {
	const remember = (ctx: ExtensionContext): void => {
		latestContext = ctx;
	};

	pi.on("message_start", async (event, ctx) => {
		remember(ctx);
		const message = (event as { message?: { role?: string } }).message;
		if (message?.role !== "assistant") return;
		const ref = messageModelRef(message as { provider?: string; model?: string });
		if (ref) costLedger.noteStreamStart(ref);
	});

	pi.on("message_update", async (event, ctx) => {
		remember(ctx);
		const delta = (event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
		if (delta?.type !== "text_delta" && delta?.type !== "thinking_delta") return;
		// `message_start` does not always carry the model yet; the first delta
		// of the stream is just as good a clock start.
		if (!costLedger.isStreaming()) {
			const partial = (event as { message?: { role?: string } }).message;
			if (partial?.role === "assistant") {
				const ref = messageModelRef(partial as { provider?: string; model?: string });
				if (ref) costLedger.noteStreamStart(ref);
			}
		}
		costLedger.noteStreamDelta(delta.delta?.length ?? 0);
	});

	pi.on("message_end", async (event, ctx) => {
		remember(ctx);
		const message = (event as { message?: { role?: string; provider?: string; model?: string; usage?: UsageLike } }).message;
		if (message?.role !== "assistant") return;
		const ref = messageModelRef(message) ?? costLedger.getCurrentModel();
		if (!ref) return;
		const usage = finiteUsage(message.usage);
		costLedger.noteStreamEnd(ref, usage.output);
		costLedger.record(ref, usage);
	});

	pi.on("model_select", async (event, ctx) => {
		remember(ctx);
		costLedger.markCurrentModel(modelRef(event.model));
	});

	pi.on("session_compact", async (event, ctx) => {
		remember(ctx);
		const usage = (event as { compactionEntry?: { usage?: UsageLike } }).compactionEntry?.usage;
		const ref = costLedger.getCurrentModel() ?? (latestContext?.model ? modelRef(latestContext.model) : undefined);
		if (usage && ref) costLedger.record(ref, finiteUsage(usage));
	});
}

/** Rebuild the ledger from the persisted session after a reload or session
 * switch, then key the current row to the window's model. Compaction and
 * branch-summary LLM calls carry no model of their own, so they land on the
 * current model — the one that made them. */
export function seedCostLedgerFromSession(ctx: {
	sessionManager: { getEntries(): Array<{ type: string; message?: unknown; usage?: UsageLike }> };
	model?: { provider: string; id: string } | undefined;
}): void {
	costLedger.reset();
	costLedger.markCurrentModel(ctx.model ? modelRef(ctx.model) : undefined);
	const current = costLedger.getCurrentModel();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message") {
			const message = entry.message as { role?: string; provider?: string; model?: string; usage?: UsageLike } | undefined;
			if (message?.role !== "assistant") continue;
			const ref = messageModelRef(message);
			if (ref) costLedger.record(ref, finiteUsage(message.usage));
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage && current) {
			costLedger.record(current, finiteUsage(entry.usage));
		}
	}
}

export function latestTrackedContext(): ExtensionContext | undefined {
	return latestContext;
}
