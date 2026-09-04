/** Bounded, abortable process runner used by Git isolation operations. */

import { spawn, type ChildProcess } from "node:child_process";

export interface CommandRunOptions {
	cwd: string;
	input?: Buffer;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxOutputBytes?: number;
	/** Extra environment entries merged over the inherited environment. */
	env?: Record<string, string>;
}

export interface CommandResult {
	code: number;
	stdout: Buffer;
	stderr: Buffer;
}

/** Injectable, shell-free command runner used by every Git operation. */
export type CommandRunner = (
	command: string,
	args: readonly string[],
	options: CommandRunOptions,
) => Promise<CommandResult>;

export const GIT_COMMAND_TIMEOUT_MS = 120_000;
export const GIT_COMMAND_KILL_GRACE_MS = 2_000;
export const GIT_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
export const WORKTREE_PATCH_MAX_BYTES = GIT_OUTPUT_MAX_BYTES;

/** Terminate the complete spawned process tree so checkout filters cannot
 * survive an abort or timeout. */
function terminateCommandTree(child: ChildProcess, force: boolean, processGroup: boolean): void {
	if (process.platform === "win32" && child.pid !== undefined) {
		const fallback = (): void => {
			try {
				child.kill(force ? "SIGKILL" : "SIGTERM");
			} catch {
				/* process may already be gone */
			}
		};
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
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
		if (processGroup && child.pid !== undefined) {
			process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
		} else {
			child.kill(force ? "SIGKILL" : "SIGTERM");
		}
	} catch {
		/* process may already be gone */
	}
}

/** Default argument-safe runner. Output is bounded before binary patches enter
 * memory, and timeout/abort terminates the complete checkout-filter process tree. */
export const runCommand: CommandRunner = (command, args, options) =>
	new Promise<CommandResult>((resolveResult, reject) => {
		if (options.signal?.aborted) {
			reject(new Error(`Command aborted before start: ${command}`));
			return;
		}
		const usePosixProcessGroup = process.platform !== "win32";
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			shell: false,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			detached: usePosixProcessGroup,
			...(options.env ? { env: { ...process.env, ...options.env } } : {}),
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const maxOutputBytes = options.maxOutputBytes ?? GIT_OUTPUT_MAX_BYTES;
		let outputBytes = 0;
		let finished = false;
		let failure: Error | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

		const terminate = (): void => {
			terminateCommandTree(child, false, usePosixProcessGroup);
			if (!forceKillTimer) {
				forceKillTimer = setTimeout(
					() => terminateCommandTree(child, true, usePosixProcessGroup),
					GIT_COMMAND_KILL_GRACE_MS,
				);
				if (typeof forceKillTimer.unref === "function") forceKillTimer.unref();
			}
		};
		const fail = (error: Error): void => {
			if (failure || finished) return;
			failure = error;
			terminate();
		};
		const append = (target: Buffer[], chunk: Buffer | string): void => {
			if (failure || finished) return;
			const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			outputBytes += value.length;
			if (outputBytes > maxOutputBytes) {
				fail(new Error(`Command output exceeded ${maxOutputBytes} bytes: ${command}`));
				return;
			}
			target.push(value);
		};
		const onAbort = (): void => fail(new Error(`Command aborted: ${command}`));
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
			timeout = setTimeout(
				() => fail(new Error(`Command timed out after ${options.timeoutMs}ms: ${command}`)),
				options.timeoutMs,
			);
			if (typeof timeout.unref === "function") timeout.unref();
		}

		child.stdout?.on("data", (chunk: Buffer | string) => append(stdout, chunk));
		child.stderr?.on("data", (chunk: Buffer | string) => append(stderr, chunk));
		child.once("error", (error) => fail(error));
		child.once("close", (code) => {
			if (finished) return;
			finished = true;
			if (timeout) clearTimeout(timeout);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			options.signal?.removeEventListener("abort", onAbort);
			if (failure) {
				reject(failure);
				return;
			}
			resolveResult({
				code: code ?? 1,
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
			});
		});
		child.stdin?.once("error", () => undefined);
		child.stdin?.end(options.input);
	});
