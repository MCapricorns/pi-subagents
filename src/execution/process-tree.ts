/** Process-tree termination shared by RPC children and Git commands. */

import { spawn, type ChildProcess } from "node:child_process";

/** Terminate a spawned child and every process in its tree. Windows uses
 * `taskkill /t`, falling back to a direct kill when taskkill is unavailable or
 * fails. POSIX children spawned as process-group leaders are signalled through
 * the negative pid so non-detached descendants receive the signal too. */
export function terminateProcessTree(proc: ChildProcess, force: boolean, processGroup = false): void {
	if (process.platform === "win32" && proc.pid !== undefined) {
		const fallback = (): void => {
			try {
				proc.kill(force ? "SIGKILL" : "SIGTERM");
			} catch {
				/* process may already be gone */
			}
		};
		const killer = spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], {
			stdio: "ignore",
			windowsHide: true,
		});
		killer.once("error", fallback);
		killer.once("close", (code) => {
			if (code !== 0) fallback();
		});
		return;
	}

	try {
		if (processGroup && proc.pid !== undefined) {
			process.kill(-proc.pid, force ? "SIGKILL" : "SIGTERM");
		} else {
			proc.kill(force ? "SIGKILL" : "SIGTERM");
		}
	} catch {
		/* process may already be gone */
	}
}
