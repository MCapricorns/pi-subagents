import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const preload = fileURLToPath(new URL("../src/execution/hidden-console.cjs", import.meta.url));
const consoleProbe = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
public static class ConsoleProbe {
 [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
}'
[Console]::Write([ConsoleProbe]::IsWindowVisible([ConsoleProbe]::GetConsoleWindow()))
`;
// Query native visibility through PowerShell 7. Use ordinary commands with
// Windows PowerShell because antivirus can terminate its dynamic P/Invoke probe.
const shellArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(consoleProbe, "utf16le").toString("base64")];
const legacyShellArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::Write(123)"];

function runFixture(source: string, nodeOptions?: string): void {
	const result = spawnSync(process.execPath, ["-e", source], {
		windowsHide: true,
		encoding: "utf8",
		timeout: 45_000,
		env: { ...process.env, ...(nodeOptions === undefined ? {} : { NODE_OPTIONS: nodeOptions }) },
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr || result.stdout);
}

describe("hidden child consoles", () => {
	for (const platform of ["darwin", "linux"]) {
		it(`leaves ${platform} process and signal options untouched`, () => {
			runFixture(`
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const original = [cp.ChildProcess.prototype.spawn, cp.spawnSync, cp.execFileSync, cp.execSync];
Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
require(${JSON.stringify(preload)})();
assert.deepEqual([cp.ChildProcess.prototype.spawn, cp.spawnSync, cp.execFileSync, cp.execSync], original);
`);
		});
	}

	it("installs once and keeps CommonJS and ESM synchronous exports aligned", { skip: process.platform !== "win32" }, () => {
		runFixture(`
(async () => {
 const assert = require("node:assert/strict");
 const cp = require("node:child_process");
 const esm = await import("node:child_process");
 const install = require(${JSON.stringify(preload)});
 const original = [cp.ChildProcess.prototype.spawn, cp.spawnSync, cp.execFileSync, cp.execSync];
 install();
 assert.deepEqual([cp.ChildProcess.prototype.spawn, cp.spawnSync, cp.execFileSync, cp.execSync], original);
 assert.equal(esm.spawnSync, cp.spawnSync);
 assert.equal(esm.execFileSync, cp.execFileSync);
 assert.equal(esm.execSync, cp.execSync);
})();
`);
	});

	for (const shell of ["pwsh.exe", "powershell.exe"]) {
		it(`hides ${shell} through asynchronous and synchronous APIs`, { skip: process.platform !== "win32" }, () => {
			runFixture(`
(async () => {
 const assert = require("node:assert/strict");
 const cp = require("node:child_process");
 const { promisify } = require("node:util");
 const launches = [];
 const originalSpawn = cp.ChildProcess.prototype.spawn;
 cp.ChildProcess.prototype.spawn = function (options) {
  launches.push({ windowsHide: options.windowsHide, detached: options.detached });
  return originalSpawn.call(this, options);
 };
 require(${JSON.stringify(preload)});
 const shell = ${JSON.stringify(shell)};
 const args = ${JSON.stringify(shell === "pwsh.exe" ? shellArgs : legacyShellArgs)};
 const expected = ${JSON.stringify(shell === "pwsh.exe" ? "False" : "123")};
 const command = [shell, ...args].join(" ");
 const options = Object.freeze({ encoding: "utf8", windowsHide: false, detached: true });
 const spawned = await new Promise((resolve, reject) => {
  const child = cp.spawn(shell, args, options);
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => stdout += data);
  child.stderr.on("data", (data) => stderr += data);
  child.on("error", reject);
  child.on("close", (code, signal) => code === 0 ? resolve(stdout) : reject(new Error(JSON.stringify({ code, signal, stdout, stderr }))));
 });
 assert.equal(spawned, expected);
 assert.equal((await promisify(cp.execFile)(shell, args, options)).stdout, expected);
 assert.equal((await promisify(cp.exec)(command, options)).stdout, expected);
 assert.equal(launches.length, 3);
 assert.ok(launches.every((options) => options.windowsHide === true && options.detached === false));
 const synced = cp.spawnSync(shell, args, options);
 assert.ifError(synced.error);
 assert.equal(synced.status, 0, synced.stderr);
 assert.equal(synced.stdout, expected);
 assert.equal(cp.execFileSync(shell, args, options), expected);
 assert.equal(cp.execSync(command, options), expected);
 assert.equal(options.windowsHide, false);
 assert.equal(options.detached, true);
})().catch((error) => { console.error(error); process.exitCode = 1; });
`);
		});
	}

	it("preserves optional arguments, output, and command errors", { skip: process.platform !== "win32" }, () => {
		runFixture(`
const assert = require("node:assert/strict");
const cp = require("node:child_process");
require(${JSON.stringify(preload)});
const options = Object.freeze({ input: 'process.stdout.write("input works")', encoding: "utf8" });
assert.equal(cp.spawnSync(process.execPath, options).stdout, "input works");
assert.equal(cp.spawnSync(process.execPath, undefined, options).stdout, "input works");
assert.equal(cp.execFileSync(process.execPath, options), "input works");
assert.equal(cp.execFileSync(process.execPath, null, options), "input works");
assert.equal(cp.execSync("echo output works").toString().trim(), "output works");
assert.throws(() => cp.execFileSync(process.execPath, ["-e", "process.exit(7)"]), { status: 7 });
assert.throws(() => cp.spawnSync(process.execPath, [], "invalid"), { code: "ERR_INVALID_ARG_TYPE" });
assert.throws(() => cp.execSync(42), { code: "ERR_INVALID_ARG_TYPE" });
assert.equal(cp.spawnSync("pi-subagents-no-such-executable").error.code, "ENOENT");
`);
	});

	it("propagates the preload through fork with paths containing spaces", { skip: process.platform !== "win32" }, async () => {
		const root = await mkdtemp(join(tmpdir(), "pi hidden console "));
		try {
			const copiedPreload = join(root, "hidden console.cjs");
			const child = join(root, "fork.cjs");
			await copyFile(preload, copiedPreload);
			await writeFile(child, `
const cp = require("node:child_process");
const output = cp.execFileSync("powershell.exe", ${JSON.stringify(legacyShellArgs)}, { encoding: "utf8" });
const installed = Boolean(cp.ChildProcess.prototype.spawn[Symbol.for("pi-subagents.hidden-console")]);
process.send({ output, installed, args: process.argv.slice(2), value: process.env.FIXTURE_VALUE });
process.disconnect();
`);
			const nodeOptions = `--no-warnings --require ${JSON.stringify(copiedPreload.replaceAll("\\", "/"))}`;
			runFixture(`
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const child = cp.fork(${JSON.stringify(child)}, ["literal space", "unicode-中"], {
 silent: true, env: { ...process.env, FIXTURE_VALUE: "kept" }
});
let message, stderr = "";
child.stderr.on("data", (data) => stderr += data);
child.on("message", (value) => message = value);
child.on("error", (error) => { throw error; });
child.on("close", (code) => {
 assert.equal(code, 0, stderr);
 assert.deepEqual(message, { output: "123", installed: true, args: ["literal space", "unicode-中"], value: "kept" });
});
`, nodeOptions);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
