import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
	BUILTIN_AGENT_NAMES, DEFAULT_CONFIG, DEFAULT_IDLE_TIMEOUT_SEC, DEFAULT_MAX_RESULT_LINES,
	initializeConfig, loadConfig, normalizeConfig, saveConfig,
} from "../src/configuration/config.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return { root, path: join(root, "pi-subagents.json") };
}

describe("worker configuration", () => {
	it("ships implementation and read-only research with independent default settings", () => {
		assert.deepEqual(BUILTIN_AGENT_NAMES, ["researcher", "worker"]);
		assert.deepEqual(DEFAULT_CONFIG, { version: 2, researcher: { thinking: "medium" }, worker: { thinking: "medium" } });
		assert.equal(DEFAULT_MAX_RESULT_LINES, 40);
		assert.equal(DEFAULT_IDLE_TIMEOUT_SEC, 1800);
	});

	it("accepts only the new schema and ignores every legacy role preference", () => {
		for (const raw of [undefined, null, [], { agentModels: { worker: "test/old" }, agentThinkingLevels: { worker: "max" } }, { version: 0, model: "test/old", thinking: "high" }]) {
			assert.deepEqual(normalizeConfig(raw), DEFAULT_CONFIG);
		}
		assert.deepEqual(normalizeConfig({ ...DEFAULT_CONFIG, worker: { model: " test/worker ", thinking: "high" }, agentModels: { sentinel: "test/review" } }),
			{ ...DEFAULT_CONFIG, worker: { model: "test/worker", thinking: "high" } });
		for (const model of ["noslash", "/model", "provider/", "bad ref/model", 10]) {
			assert.deepEqual(normalizeConfig({ ...DEFAULT_CONFIG, worker: { model, thinking: "ultra" } }), DEFAULT_CONFIG);
		}
	});

	it("creates missing settings once and keeps current settings untouched", async (t) => {
		const { path } = await fixture(t);
		assert.equal(await initializeConfig(path), "created");
		await saveConfig({ ...DEFAULT_CONFIG, worker: { model: "test/worker", thinking: "high" } }, path);
		const time = new Date("2000-01-01T00:00:00Z");
		await utimes(path, time, time);
		const before = await stat(path);
		assert.equal(await initializeConfig(path), undefined);
		assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
		assert.deepEqual(await loadConfig(path), { ...DEFAULT_CONFIG, worker: { model: "test/worker", thinking: "high" } });
	});

	for (const legacy of [JSON.stringify({ agentModels: { worker: "test/old", sentinel: "test/review" }, agentThinkingLevels: { worker: "max" } }), "{broken", JSON.stringify({ version: 1, model: "test/old", thinking: "high" })]) {
		it("overwrites unsupported settings and initializes defaults without keeping legacy files: " + legacy.slice(0, 35), async (t) => {
			const { root, path } = await fixture(t);
			await writeFile(path, legacy);
			const recovery = join(root, "recovery.json");
			await writeFile(recovery, "keep recovery evidence");
			await assert.rejects(loadConfig(path), /invalid or unsupported/u, "dispatch never turns a bad config into main-model spending");
			assert.equal(await readFile(path, "utf8"), legacy, "dispatch reads do not own initialization");
			assert.equal(await initializeConfig(path), "reset");
			assert.deepEqual(JSON.parse(await readFile(path, "utf8")), DEFAULT_CONFIG);
			assert.equal(await readFile(recovery, "utf8"), "keep recovery evidence");
			assert.deepEqual((await readdir(root)).sort(), ["pi-subagents.json", "recovery.json"]);
		});
	}

	it("serializes simultaneous initialization so only one caller reports a reset", async (t) => {
		const { path } = await fixture(t);
		await writeFile(path, JSON.stringify({ agentModels: { worker: "test/old" } }));
		const results = await Promise.all([initializeConfig(path), initializeConfig(path), initializeConfig(path)]);
		assert.equal(results.filter((result) => result === "reset").length, 1);
		assert.deepEqual(await loadConfig(path), DEFAULT_CONFIG);
	});

	it("rejects invalid model references without silently choosing main", async (t) => {
		const { path } = await fixture(t);
		for (const model of ["typo", "provider/", "", null]) {
			await writeFile(path, JSON.stringify({ ...DEFAULT_CONFIG, worker: { model, thinking: "medium" } }));
			await assert.rejects(loadConfig(path), /Invalid worker model reference/u);
			assert.equal(await initializeConfig(path), "reset", "setup can explicitly recover invalid settings");
			assert.deepEqual(await loadConfig(path), DEFAULT_CONFIG);
		}
	});

	it("preserves the old file when preparing its replacement fails", async (t) => {
		const { path } = await fixture(t);
		const legacy = JSON.stringify({ agentModels: { worker: "test/old" } });
		await writeFile(path, legacy);
		const original = fs.writeFile;
		t.mock.method(fs, "writeFile", async (...args: any[]) => {
			if (String(args[0]).endsWith(".tmp")) throw new Error("disk full");
			return (original as any)(...args);
		});
		syncBuiltinESMExports();
		try {
			await assert.rejects(initializeConfig(path), /disk full/u);
			assert.equal(await readFile(path, "utf8"), legacy);
		} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
	});

	it("does not delete unreadable settings", async (t) => {
		const { path } = await fixture(t);
		const { mkdir } = await import("node:fs/promises");
		await mkdir(path);
		await assert.rejects(initializeConfig(path));
		assert.ok((await stat(path)).isDirectory());
		await assert.rejects(loadConfig(path));
	});
});
