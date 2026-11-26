import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";

function installGitHooks() {
	// The npm lifecycle also runs outside a Git checkout. Only configure this project.
	const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
	if (root.status !== 0 || realpathSync(root.stdout.trim()) !== realpathSync(".") || !existsSync(".githooks/pre-commit")) return;

	const hooksPath = spawnSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8" });
	if (hooksPath.status === 0 && hooksPath.stdout.trim() === ".githooks") return;
	if (hooksPath.status !== 0 && hooksPath.status !== 1) throw new Error("Could not read Git's hook configuration.");

	const defaultDir = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { encoding: "utf8" }).trim();
	const hasDefaultHooks = existsSync(defaultDir) && readdirSync(defaultDir).some((name) => !name.endsWith(".sample"));
	if (hooksPath.status === 0 || hasDefaultHooks) {
		console.log("Existing Git hooks retained. Add `npm run check:staged` to your pre-commit hook to run the unused-code check.");
		return;
	}

	execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"]);
}

installGitHooks();
