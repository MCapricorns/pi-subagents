import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this check with npm run check:staged.");

const dependencies = resolve("node_modules");
if (!existsSync(dependencies)) throw new Error("Run npm ci before committing so the unused-code check has its dependencies.");

// Check the staged tree without stashing, rewriting the index, or reading unstaged sources.
const snapshot = mkdtempSync(join(tmpdir(), "pi-subagents-staged-"));
try {
	const prefix = snapshot.replaceAll("\\", "/") + "/";
	execFileSync("git", ["checkout-index", "--all", "--ignore-skip-worktree-bits", `--prefix=${prefix}`], { stdio: "inherit" });
	symlinkSync(dependencies, join(snapshot, "node_modules"), "junction");
	const check = spawnSync(process.execPath, [npmCli, "run", "check:unused"], { cwd: snapshot, stdio: "inherit" });
	if (check.error) throw check.error;
	process.exitCode = check.status ?? 1;
} finally {
	rmSync(snapshot, { recursive: true, force: true });
}
