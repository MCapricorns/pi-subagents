import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const processTreeModule = new URL("../src/execution/process-tree.ts", import.meta.url).href;

function runFixture(source: string): void {
	const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "--eval", `
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { terminateProcessTree } from ${JSON.stringify(processTreeModule)};
Object.defineProperty(process, "platform", { value: "win32" });
const signals = [];
const proc = { pid: 12345, kill(signal) { signals.push(signal); } };
${source}
await new Promise((resolve) => setImmediate(resolve));
console.log("fixture survived");
`], {
		encoding: "utf8", windowsHide: true, timeout: 10_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(result.stdout, /fixture survived/u);
}

describe("Windows process-tree termination", () => {
	for (const force of [false, true]) {
		for (const caller of ["timer", "stop"]) {
			it(`falls back after native taskkill ENOMEM from ${caller} (force=${force})`, () => {
				runFixture(`
let launches = 0;
// Keep Node's own synchronous spawn failure path without launching taskkill.
process.binding("process_wrap").Process.prototype.spawn = function () {
 launches++;
 return process.binding("uv").UV_ENOMEM;
};
${caller === "timer"
 ? `await new Promise((resolve) => setTimeout(() => { terminateProcessTree(proc, ${force}); resolve(); }, 0));`
 : `void (async () => { terminateProcessTree(proc, ${force}); })();
await new Promise((resolve) => setImmediate(resolve));`}
assert.equal(launches, 1);
assert.deepEqual(signals, [${JSON.stringify(force ? "SIGKILL" : "SIGTERM")}]);
`);
			});
		}
	}

	for (const outcome of ["error", "nonzero close", "successful close", "listener failure"]) {
		it(`preserves the direct-kill fallback policy for taskkill ${outcome}`, () => {
			runFixture(`
const killer = new EventEmitter();
childProcess.spawn = (command, args, options) => {
 assert.equal(command, "taskkill");
 assert.deepEqual(args, ["/pid", "12345", "/t", "/f"]);
 assert.deepEqual(options, { stdio: "ignore", windowsHide: true });
 return killer;
};
syncBuiltinESMExports();
${outcome === "listener failure" ? `killer.once = () => { throw new Error("listener installation failed"); };` : ""}
terminateProcessTree(proc, false);
${outcome === "error" ? `killer.emit("error", new Error("taskkill unavailable"));`
 : outcome === "nonzero close" ? `killer.emit("close", 1);`
 : outcome === "successful close" ? `killer.emit("close", 0);` : ""}
assert.deepEqual(signals, ${outcome === "successful close" ? "[]" : '["SIGTERM"]'});
`);
		});
	}
});
