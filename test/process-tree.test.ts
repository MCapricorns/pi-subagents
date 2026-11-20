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
	it("falls back to direct signals across taskkill spawn and close failures", () => {
		runFixture(`
const nativeSpawn = process.binding("process_wrap").Process.prototype.spawn;
for (const force of [false, true]) {
 signals.length = 0;
 let launches = 0;
 process.binding("process_wrap").Process.prototype.spawn = function () {
  launches++;
  return process.binding("uv").UV_ENOMEM;
 };
 terminateProcessTree(proc, force);
 assert.equal(launches, 1);
 assert.deepEqual(signals, [force ? "SIGKILL" : "SIGTERM"]);
}
process.binding("process_wrap").Process.prototype.spawn = nativeSpawn;

for (const outcome of ["error", "nonzero close", "successful close", "listener failure"]) {
 signals.length = 0;
 const killer = new EventEmitter();
 childProcess.spawn = (command, args, options) => {
  assert.equal(command, "taskkill");
  assert.deepEqual(args, ["/pid", "12345", "/t", "/f"]);
  assert.deepEqual(options, { stdio: "ignore", windowsHide: true });
  return killer;
 };
 syncBuiltinESMExports();
 if (outcome === "listener failure") killer.once = () => { throw new Error("listener installation failed"); };
 terminateProcessTree(proc, false);
 if (outcome === "error") killer.emit("error", new Error("taskkill unavailable"));
 else if (outcome === "nonzero close") killer.emit("close", 1);
 else if (outcome === "successful close") killer.emit("close", 0);
 assert.deepEqual(signals, outcome === "successful close" ? [] : ["SIGTERM"], outcome);
}
`);
	});
});
