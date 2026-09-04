import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import {
	analyzeSubagentRisk,
	classifyRiskPaths,
	type GitRiskRunner,
} from "../src/delegation/risk.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
	await execFileAsync("git", ["-C", cwd, ...args], { windowsHide: true });
}

describe("subagent risk advisory", () => {
	it("classifies fixed explainable path categories", () => {
		const classification = classifyRiskPaths([
			"src/execution/background.ts",
			"src/auth/permissions.ts",
			"src/lifecycle/durable.ts",
			"src/cancel/abort-handler.ts",
			"README.md",
		]);
		assert.deepEqual(classification.categories, [
			"concurrency",
			"trust-boundary",
			"persistence-compatibility",
			"failure-cancellation",
		]);
		assert.equal(classification.recommendSentinel, true);
		assert.deepEqual(classification.matches["trust-boundary"], ["src/auth/permissions.ts"]);
	});

	it("reads tracked changes and untracked paths relative to HEAD", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-risk-git-"));
		try {
			await git(root, "init", "--quiet");
			await git(root, "config", "user.email", "test@example.com");
			await git(root, "config", "user.name", "Test User");
			await writeFile(join(root, "queue.ts"), "export const queue = 1;\n", "utf8");
			await git(root, "add", "queue.ts");
			await git(root, "commit", "--quiet", "-m", "initial");
			await writeFile(join(root, "queue.ts"), "export const queue = 2;\n", "utf8");
			await writeFile(join(root, "auth-policy.ts"), "export {};\n", "utf8");

			const advisory = await analyzeSubagentRisk(root);
			assert.equal(advisory.available, true);
			assert.deepEqual(advisory.changedPaths, ["auth-policy.ts", "queue.ts"]);
			assert.deepEqual(advisory.categories, ["concurrency", "trust-boundary"]);
			assert.equal(advisory.recommendSentinel, true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("anchors nested-cwd inspection at the repository root", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-risk-nested-"));
		const nested = join(root, "packages", "app");
		try {
			await mkdir(nested, { recursive: true });
			await git(root, "init", "--quiet");
			await git(root, "config", "user.email", "test@example.com");
			await git(root, "config", "user.name", "Test User");
			await writeFile(join(nested, "queue.ts"), "export const queue = 1;\n", "utf8");
			await git(root, "add", ".");
			await git(root, "commit", "--quiet", "-m", "initial");
			await writeFile(join(nested, "queue.ts"), "export const queue = 2;\n", "utf8");
			await writeFile(join(root, "auth-policy.ts"), "export {};\n", "utf8");

			const advisory = await analyzeSubagentRisk(nested);
			assert.equal(advisory.available, true);
			assert.deepEqual(advisory.changedPaths, ["auth-policy.ts", "packages/app/queue.ts"]);
			assert.deepEqual(advisory.categories, ["concurrency", "trust-boundary"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reports Git unavailability without recommending or blocking", async () => {
		const unavailable: GitRiskRunner = async () => {
			throw new Error("git executable was not found");
		};
		const advisory = await analyzeSubagentRisk(process.cwd(), unavailable);
		assert.equal(advisory.available, false);
		assert.deepEqual(advisory.changedPaths, []);
		assert.deepEqual(advisory.categories, []);
		assert.equal(advisory.recommendSentinel, false);
		assert.match(advisory.unavailableReason ?? "", /git executable was not found/i);
	});

	it("rethrows cancellation instead of reporting Git unavailable", async () => {
		const controller = new AbortController();
		let calls = 0;
		const ignoresCancellation: GitRiskRunner = async () => {
			calls += 1;
			return "";
		};
		controller.abort();
		await assert.rejects(
			analyzeSubagentRisk(process.cwd(), ignoresCancellation, controller.signal),
			(error: unknown) => error instanceof Error && error.name === "AbortError",
		);
		assert.equal(calls, 0);
	});
});
