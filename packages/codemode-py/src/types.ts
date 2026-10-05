export interface CodemodeToolContext {
	/**
	 * Aborted when the script finishes (including unawaited calls), the
	 * execution times out, the caller aborts, or the execution environment is closed.
	 */
	signal: AbortSignal;
}

/** A JSON Schema document. Only used to render declarations; values are not validated against it. */
export type CodemodeJsonSchema = { [key: string]: unknown } | boolean;

export interface CodemodeTool {
	/**
	 * The script calls tools as `tools.<id>(args)`, where `<id>` is the name with characters that
	 * are not valid in identifiers replaced by `_` (see `toCodemodeIdentifier`), and also as
	 * `tools["<name>"](args)`. Globals are called as `<name>(args)` and must be identifiers, or
	 * `<namespace>.<member>`, which groups them into an ordinary Python namespace.
	 * Aliases preserve leading digits with a prefix, suffix Python keywords, and reject collisions
	 * or reserved namespace attributes at registration.
	 */
	name: string;
	/** Shown as a Python docstring in {@link renderDeclarations}, and listed in `ALL_TOOLS` for tools. */
	description?: string;
	/** Schema of the single argument. Rendered as the parameter type; `Any` when omitted. */
	inputSchema?: CodemodeJsonSchema;
	/** Schema of the resolved value. Rendered as the async function return type; `Any` when omitted. */
	outputSchema?: CodemodeJsonSchema;
	/** Globals only: `execute` receives all call arguments as an array instead of the first one. */
	spread?: boolean;
	/**
	 * Globals only: Python parameter list and return annotation for {@link renderDeclarations}, for
	 * example `(kind: str, id: str | None = None) -> list[dict[str, Any]]`.
	 * Replaces the rendering from the schemas, without `async def` or a trailing colon.
	 */
	signature?: string;
	/**
	 * `args` is whatever the script passed, after a JSON round trip. The return
	 * value must be JSON-serializable; a thrown error surfaces in the script as
	 * a Python `RuntimeError` with the same message.
	 */
	execute(args: unknown, context: CodemodeToolContext): Promise<unknown> | unknown;
}

/**
 * One item of the script's output, in the order the script produced it: `text()` and Python streams
 * produce text items, `image()` image items. `data` is base64.
 */
export type CodemodeOutputItem = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type CodemodeCallStatus = "ok" | "error" | "cancelled";

export interface CodemodeCall {
	name: string;
	status: CodemodeCallStatus;
	durationMs: number;
}

export type CodemodeErrorKind =
	/** The script threw or failed to parse. `name` and `stack` come from the script's error. */
	| "script"
	/** The overall deadline expired. The worker was terminated. */
	| "timeout"
	/** The caller's signal fired or the environment was closed. Python was terminated. */
	| "aborted"
	/** Python startup, lifecycle setup, or bridge transport failed outside the script. */
	| "exec";

export interface CodemodeError {
	kind: CodemodeErrorKind;
	name?: string;
	message: string;
	stack?: string;
}

/** Keys the script changed with `store()`. Only successful executions report writes. */
export interface CodemodeStoreWrites {
	set: Record<string, Uint8Array>;
	/** Keys stored as Python `None`. */
	delete: string[];
}

/** Output is kept on failure. Top-level None/implicit return/exit() yield {}. */
export type CodemodeResult =
	| {
			ok: true;
			value: unknown;
			output: CodemodeOutputItem[];
			calls: CodemodeCall[];
			storeWrites: CodemodeStoreWrites;
	  }
	| { ok: false; error: CodemodeError; output: CodemodeOutputItem[]; calls: CodemodeCall[] };

export interface CodemodeExecutionEnvOptions {
	/** Working directory for Python and its subprocesses. Defaults to the host working directory. */
	cwd?: string;
	tools?: CodemodeTool[];
	/**
	 * Functions exposed as top-level identifiers instead of on `tools`, for host helpers such as
	 * attaching an image to the result. They behave like tools (JSON round trip, promise result)
	 * but are not recorded in `result.calls`. Names must be Python identifiers and may not shadow the
	 * built-in globals (`tools`, `ALL_TOOLS`, `text`, `exit`, `store`, `load`).
	 * A host `image` global can replace the built-in image helper.
	 */
	globals?: CodemodeTool[];
	/**
	 * Overall deadline per execution, including time spent in tools. `Infinity` disables the
	 * deadline; the execution then only ends when the script settles or is aborted.
	 * Default: 300000.
	 */
	timeoutMs?: number;
}

/** @deprecated Use CodemodeExecutionEnvOptions; execution is not sandboxed. */
export type CodemodeSandboxOptions = CodemodeExecutionEnvOptions;

export interface CodemodeExecuteOptions {
	signal?: AbortSignal;
	/** Overrides the environment default for this execution. */
	timeoutMs?: number;
	/**
	 * Opaque serialized pickle bytes the script reads with `load(key)`. The script's own
	 * `store()` calls come back as `result.storeWrites`; persisting them is up to the caller.
	 */
	store?: Readonly<Record<string, Uint8Array>>;
}
