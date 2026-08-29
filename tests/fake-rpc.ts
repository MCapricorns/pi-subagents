export interface FakeRpcScriptOptions {
	setup?: string;
	/** Runs after receipt/counting but before agent_start and onPrompt. Override
	 * to delay or reject prompt preflight; the snippet must call respond(). */
	onPromptPreflight?: string;
	onPrompt: string;
	onAbort?: string;
	onAbortRetry?: string;
	onGetState?: string;
	/** Data returned for a clear_queue command; defaults to empty queues. */
	clearQueueData?: Record<string, unknown[]>;
	/** Respond to clear_queue with a rejection, as an older pi child would. */
	clearQueueFail?: boolean;
	/** Runs when a clear_queue command arrives, before the canned response. */
	onClearQueue?: string;
	emitAgentStart?: boolean;
	autoSettle?: boolean;
}

/** Build a dependency-free fake pi child that speaks strict LF JSONL RPC. */
export function fakeRpcScript(options: FakeRpcScriptOptions): string {
	return `
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const dirIndex = process.argv.indexOf("--session-dir");
const createIndex = process.argv.indexOf("--session-id");
const resumeIndex = process.argv.indexOf("--session");
const sessionDir = dirIndex === -1 ? undefined : process.argv[dirIndex + 1];
const sessionId = createIndex !== -1 ? process.argv[createIndex + 1] : resumeIndex !== -1 ? process.argv[resumeIndex + 1] : undefined;
if (sessionDir && sessionId && createIndex !== -1) {
	fs.mkdirSync(sessionDir, { recursive: true });
	fs.writeFileSync(path.join(sessionDir, Date.now() + "Z_" + sessionId + ".jsonl"), JSON.stringify({ type: "session", id: sessionId }) + "\\n");
}
${options.setup ?? ""}
let inputBuffer = "";
let promptCount = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const respond = (command, success = true, error, data) => send({ id: command.id, type: "response", command: command.type, success, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) });
const handle = async (command) => {
	if (command.type === "prompt") {
		promptCount++;
		${options.onPromptPreflight ?? "respond(command);"}
		${options.emitAgentStart === false ? "" : "send({ type: \"agent_start\" });"}
		const input = command.message;
		${options.onPrompt}
		${options.autoSettle === false ? "" : "send({ type: \"agent_settled\" });"}
		return;
	}
	if (command.type === "clear_queue") {
		${options.onClearQueue ?? ""}
		if (${options.clearQueueFail ? "true" : "false"}) respond(command, false, "unknown command");
		else respond(command, true, undefined, ${JSON.stringify(options.clearQueueData ?? { steering: [], followUp: [] })});
		return;
	}
	if (command.type === "abort") {
		respond(command);
		${options.onAbort ?? 'send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } }); send({ type: "agent_settled" });'}
		return;
	}
	if (command.type === "abort_retry") {
		respond(command);
		${options.onAbortRetry ?? ""}
		return;
	}
	if (command.type === "get_state") {
		${options.onGetState ?? "respond(command);"}
		return;
	}
	respond(command);
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	inputBuffer += chunk;
	while (true) {
		const lf = inputBuffer.indexOf("\\n");
		if (lf === -1) break;
		let line = inputBuffer.slice(0, lf);
		inputBuffer = inputBuffer.slice(lf + 1);
		if (line.endsWith("\\r")) line = line.slice(0, -1);
		if (!line.trim()) continue;
		void handle(JSON.parse(line));
	}
});
process.stdin.resume();
`;
}
