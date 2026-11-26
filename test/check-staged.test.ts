import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

it("checks the staged snapshot and preserves the checkout and index when the check fails", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-staged-test-"));
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	const source = join(root, "source.txt");
	const fakeNpm = join(root, "fake-npm.mjs");
	const checkStaged = fileURLToPath(new URL("../scripts/check-staged.mjs", import.meta.url));
	await mkdir(join(root, "node_modules"));
	await writeFile(fakeNpm, `
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
assert.deepEqual(process.argv.slice(2), ["run", "check:unused"]);
assert.ok(statSync("node_modules").isDirectory());
process.exitCode = readFileSync("source.txt", "utf8") === "clean" ? 0 : 7;
`);
	const runGate = () => spawnSync(process.execPath, [checkStaged], {
		cwd: root, encoding: "utf8", env: { ...process.env, npm_execpath: fakeNpm },
	});

	git("init", "-q");
	await writeFile(source, "unused");
	git("add", "source.txt");
	await writeFile(source, "clean");
	const rejected = runGate();
	assert.equal(rejected.status, 7, rejected.stderr);
	assert.equal(git("show", ":source.txt"), "unused");
	assert.equal(await readFile(source, "utf8"), "clean");

	git("add", "source.txt");
	await writeFile(source, "unused");
	const accepted = runGate();
	assert.equal(accepted.status, 0, accepted.stderr);
	assert.equal(git("show", ":source.txt"), "clean");
	assert.equal(await readFile(source, "utf8"), "unused");
});
