/** Hide console windows created by tools and extensions inside a Windows child.
 * windowsHide applies to one launch; it is not inherited by descendants.
 * CommonJS lets Node preload this before Pi starts, without a TypeScript loader;
 * the exported factory also supports Pi runtimes that load it as an extension. */
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const installed = Symbol.for("pi-subagents.hidden-console");

function installHiddenConsole() {
	if (process.platform !== "win32" || childProcess.ChildProcess.prototype.spawn[installed]) return;

	// spawn, exec, execFile and fork all reach this method, including references
	// imported before installation. Keep stdio, arguments and cancellation intact.
	const originalSpawn = childProcess.ChildProcess.prototype.spawn;
	function hiddenSpawn(options) {
		return originalSpawn.call(this, { ...options, windowsHide: true, detached: false });
	}
	hiddenSpawn[installed] = true;
	childProcess.ChildProcess.prototype.spawn = hiddenSpawn;

	// The synchronous APIs close over Node's own spawnSync, so replacing only
	// the exported spawnSync would leave execSync and execFileSync uncovered.
	for (const name of ["spawnSync", "execFileSync", "execSync"]) {
		const original = childProcess[name];
		childProcess[name] = function (...args) {
			const hasArgsSlot = Array.isArray(args[1]) || (args[1] == null && args.length > 2);
			const index = name !== "execSync" && hasArgsSlot ? 2 : 1;
			const options = args[index];
			// Leave invalid options to Node's normal argument validation.
			if (options == null || typeof options === "object") {
				args[index] = { ...options, windowsHide: true, detached: false };
			}
			return original.apply(this, args);
		};
	}
	syncBuiltinESMExports();
}

installHiddenConsole();
module.exports = installHiddenConsole;
