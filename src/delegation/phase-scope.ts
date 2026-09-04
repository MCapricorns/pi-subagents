import { isAbsolute, relative, resolve, sep } from "node:path";

export interface SymbolScopeClaim {
	path: string;
	name: string;
}

export interface PhaseScopeInput {
	paths?: string[];
	symbols?: SymbolScopeClaim[];
}

/** Absolute, platform-normalized claims used only for deterministic admission. */
export interface PhaseScope {
	paths?: string[];
	symbols?: SymbolScopeClaim[];
}

export interface PhaseScopeOverlap {
	left: string;
	right: string;
	kind: "path-path" | "path-symbol" | "symbol-symbol";
}

export const PHASE_ID_MAX_LENGTH = 80;
export const PHASE_ID_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._:-]*$";
const PHASE_ID_PATTERN = new RegExp(PHASE_ID_PATTERN_SOURCE, "u");
const WILDCARD_PATH = /[*?]/u;

function normalizePathCase(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

function normalizeClaimPath(path: unknown, cwd: string, label: string): string {
	if (typeof path !== "string" || path.trim().length === 0) {
		throw new Error(`${label} must be a non-blank exact file or directory path.`);
	}
	const trimmed = path.trim();
	if (WILDCARD_PATH.test(trimmed)) {
		throw new Error(`${label} must be exact; wildcard * and ? inputs are not supported. Other punctuation is treated literally.`);
	}
	return normalizePathCase(resolve(cwd, trimmed));
}

export function normalizePhaseId(phaseId: string | undefined): string | undefined {
	if (phaseId === undefined) return undefined;
	if (
		typeof phaseId !== "string" ||
		phaseId.length > PHASE_ID_MAX_LENGTH ||
		!PHASE_ID_PATTERN.test(phaseId)
	) {
		throw new Error(`phaseId must be a single-line identifier of 1-${PHASE_ID_MAX_LENGTH} ASCII letters, numbers, or ._:- characters, starting with a letter or number.`);
	}
	return phaseId;
}

/** Resolve exact claims against the caller-facing cwd. An omitted scope remains
 * compatible; a present scope must contain at least one valid claim. */
export function normalizePhaseScope(
	scope: PhaseScopeInput | undefined,
	cwd: string,
): PhaseScope | undefined {
	if (scope === undefined) return undefined;
	if (!scope || typeof scope !== "object") throw new Error("scope must be an object when provided.");
	if (scope.paths !== undefined && !Array.isArray(scope.paths)) throw new Error("scope.paths must be an array.");
	if (scope.symbols !== undefined && !Array.isArray(scope.symbols)) throw new Error("scope.symbols must be an array.");

	const paths = [...new Set((scope.paths ?? []).map((path, index) =>
		normalizeClaimPath(path, cwd, `scope.paths[${index}]`),
	))];
	const symbols: SymbolScopeClaim[] = [];
	const symbolKeys = new Set<string>();
	for (const [index, symbol] of (scope.symbols ?? []).entries()) {
		if (!symbol || typeof symbol !== "object") {
			throw new Error(`scope.symbols[${index}] must contain an exact path and symbol name.`);
		}
		const path = normalizeClaimPath(symbol.path, cwd, `scope.symbols[${index}].path`);
		if (typeof symbol.name !== "string" || symbol.name.trim().length === 0) {
			throw new Error(`scope.symbols[${index}].name must be non-blank.`);
		}
		const name = symbol.name.trim();
		const key = `${path}\0${name}`;
		if (!symbolKeys.has(key)) {
			symbolKeys.add(key);
			symbols.push({ path, name });
		}
	}
	if (paths.length === 0 && symbols.length === 0) {
		throw new Error("scope must contain at least one valid claim in paths or symbols.");
	}
	return {
		...(paths.length > 0 ? { paths } : {}),
		...(symbols.length > 0 ? { symbols } : {}),
	};
}

/** Merge normalized continuation claims monotonically so retained edits never lose coverage. */
export function mergePhaseScopes(
	previous: PhaseScope | undefined,
	additional: PhaseScope | undefined,
): PhaseScope | undefined {
	if (!previous) return additional;
	if (!additional) return previous;
	const paths = [...new Set([...(previous.paths ?? []), ...(additional.paths ?? [])])];
	const symbols: SymbolScopeClaim[] = [];
	const symbolKeys = new Set<string>();
	for (const symbol of [...(previous.symbols ?? []), ...(additional.symbols ?? [])]) {
		const key = `${symbol.path}\0${symbol.name}`;
		if (symbolKeys.has(key)) continue;
		symbolKeys.add(key);
		symbols.push(symbol);
	}
	return {
		...(paths.length > 0 ? { paths } : {}),
		...(symbols.length > 0 ? { symbols } : {}),
	};
}

function containsPath(ancestor: string, candidate: string): boolean {
	if (ancestor === candidate) return true;
	const child = relative(ancestor, candidate);
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function describeSymbol(symbol: SymbolScopeClaim): string {
	return `${symbol.path}#${symbol.name}`;
}

/** Return the first deterministic overlap. Path claims cover the named path and
 * descendants; symbols on the same file overlap only when their names match. */
export function findPhaseScopeOverlap(
	left: PhaseScope,
	right: PhaseScope,
): PhaseScopeOverlap | undefined {
	for (const leftPath of left.paths ?? []) {
		for (const rightPath of right.paths ?? []) {
			if (containsPath(leftPath, rightPath) || containsPath(rightPath, leftPath)) {
				return { left: leftPath, right: rightPath, kind: "path-path" };
			}
		}
	}
	for (const leftPath of left.paths ?? []) {
		for (const rightSymbol of right.symbols ?? []) {
			if (containsPath(leftPath, rightSymbol.path)) {
				return { left: leftPath, right: describeSymbol(rightSymbol), kind: "path-symbol" };
			}
		}
	}
	for (const leftSymbol of left.symbols ?? []) {
		for (const rightPath of right.paths ?? []) {
			if (containsPath(rightPath, leftSymbol.path)) {
				return { left: describeSymbol(leftSymbol), right: rightPath, kind: "path-symbol" };
			}
		}
	}
	for (const leftSymbol of left.symbols ?? []) {
		for (const rightSymbol of right.symbols ?? []) {
			if (leftSymbol.path === rightSymbol.path && leftSymbol.name === rightSymbol.name) {
				return {
					left: describeSymbol(leftSymbol),
					right: describeSymbol(rightSymbol),
					kind: "symbol-symbol",
				};
			}
		}
	}
	return undefined;
}

export interface WriterScopeLease {
	id: number;
	agentName: string;
	state: "queued" | "resuming" | "running" | "interrupting" | "parked" | "completed" | "failed" | "stopped";
	lifecycleOperation?: "park" | "resume" | "stop" | "settle";
	retired?: boolean;
	scope?: PhaseScope;
	/** Transient monotonic scope claimed while a continuation is preparing. */
	admissionScope?: PhaseScope;
	writeCapable?: boolean;
}

export interface WriterLeaseScopeOverlap {
	lease: WriterScopeLease;
	overlap: PhaseScopeOverlap;
}

const SCOPE_ADMISSION_STATES = new Set<WriterScopeLease["state"]>(["queued", "resuming", "running", "interrupting", "parked"]);

/** Compare absolute normalized claims against active writer leases. Scope identity,
 * unlike phase identity, is independent of the caller's cwd. Settled phases do not block. */
export function findWriterLeaseScopeOverlap(
	scope: PhaseScope,
	leases: Iterable<WriterScopeLease>,
	excludeRunId?: number,
): WriterLeaseScopeOverlap | undefined {
	for (const lease of leases) {
		if (lease.id === excludeRunId) continue;
		const active = lease.lifecycleOperation === "settle" || SCOPE_ADMISSION_STATES.has(lease.state);
		const leaseScope = lease.admissionScope ?? lease.scope;
		const writes =
			lease.admissionScope !== undefined ||
			(lease.writeCapable ?? lease.agentName !== "scout");
		if (!active || lease.retired || !writes || !leaseScope) continue;
		const overlap = findPhaseScopeOverlap(scope, leaseScope);
		if (overlap) return { lease, overlap };
	}
	return undefined;
}
