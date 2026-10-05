import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { toCodemodeIdentifier, validateGlobalNames, validateToolNames } from "../identifier.ts";
import type {
	CodemodeCall, CodemodeError, CodemodeExecuteOptions, CodemodeOutputItem, CodemodeResult,
	CodemodeExecutionEnvOptions, CodemodeStoreWrites, CodemodeTool,
} from "../types.ts";
import { MAX_BRIDGE_BYTES, MAX_OUTPUT_CHARS, MAX_OUTPUT_ITEMS, MAX_STORE_TOTAL_BYTES, MAX_STORE_VALUE_BYTES } from "./limits.ts";
import type { HostToPythonMessage, PythonToHostMessage } from "./protocol.ts";
import { BOOTSTRAP_SOURCE, RUNNER_SOURCE } from "./python-source.ts";

const DEFAULT_TIMEOUT_MS = 300_000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function serializeStore(store: CodemodeExecuteOptions["store"]): Record<string, string> {
	const serialized: Record<string, string> = Object.create(null);
	let total = 0;
	for (const [key, value] of Object.entries(store ?? {})) {
		if (!(value instanceof Uint8Array)) throw new TypeError(`Store value "${key}" must be Uint8Array pickle bytes`);
		if (value.byteLength > MAX_STORE_VALUE_BYTES) throw new RangeError(`Store value "${key}" exceeds ${MAX_STORE_VALUE_BYTES} pickle bytes`);
		total += value.byteLength;
		if (total > MAX_STORE_TOTAL_BYTES) throw new RangeError(`Store exceeds ${MAX_STORE_TOTAL_BYTES} pickle bytes`);
		serialized[key] = Buffer.from(value).toString("base64");
	}
	return serialized;
}

function parseStoreWrites(values: Record<string, string | null>): CodemodeStoreWrites {
	const writes: CodemodeStoreWrites = { set: Object.create(null), delete: [] };
	let total = 0;
	for (const [key, value] of Object.entries(values)) {
		if (value === null) {
			writes.delete.push(key);
		} else {
			if (typeof value !== "string") throw new Error("Invalid pickle store write");
			const bytes = Buffer.from(value, "base64");
			if (bytes.toString("base64") !== value || bytes.byteLength > MAX_STORE_VALUE_BYTES) throw new Error("Invalid pickle store write");
			total += bytes.byteLength;
			if (total > MAX_STORE_TOTAL_BYTES) throw new Error("Pickle store writes exceed total limit");
			writes.set[key] = new Uint8Array(bytes);
		}
	}
	return writes;
}

interface PendingCall {
	record: CodemodeCall | undefined;
	startedAt: number;
	controller: AbortController;
}

interface ExecutionOptions {
	cwd: string | undefined;
	code: string;
	tools: ReadonlyMap<string, CodemodeTool>;
	globals: ReadonlyMap<string, CodemodeTool>;
	timeoutMs: number;
	signal: AbortSignal | undefined;
	store: Record<string, string>;
}

/** One trusted Python process per execution; no sandbox or memory-limit promise. */
class Execution {
	readonly promise: Promise<CodemodeResult>;
	private resolveResult!: (result: CodemodeResult) => void;
	private child: ChildProcess | undefined;
	private server: Server | undefined;
	private socket: Socket | undefined;
	private readonly sockets = new Set<Socket>();
	private readonly signal: AbortSignal | undefined;
	private timer: NodeJS.Timeout | undefined;
	private readonly output: CodemodeOutputItem[] = [];
	private outputChars = 0;
	private readonly calls: CodemodeCall[] = [];
	private readonly pending = new Map<number, PendingCall>();
	private finished = false;
	private diagnostics = "";
	private readonly options: ExecutionOptions;

	constructor(options: ExecutionOptions) {
		this.options = options;
		this.promise = new Promise<CodemodeResult>((resolve) => { this.resolveResult = resolve; });
		this.signal = options.signal;
		if (Number.isFinite(options.timeoutMs)) {
			this.timer = setTimeout(() => this.finish({ kind: "timeout", message: `Execution timed out after ${options.timeoutMs} ms` }), options.timeoutMs);
		}
		if (options.signal?.aborted) {
			this.onAbort();
			return;
		}
		options.signal?.addEventListener("abort", this.onAbort, { once: true });
		this.start();
	}

	abort(message: string): Promise<CodemodeResult> {
		this.finish({ kind: "aborted", message });
		return this.promise;
	}

	private start(): void {
		const token = randomBytes(32).toString("hex");
		const server = createServer((socket) => this.accept(socket, token));
		this.server = server;
		server.on("error", (error) => this.finish({ kind: "exec", message: `Bridge startup failed: ${errorMessage(error)}` }));
		server.listen(0, "127.0.0.1", () => {
			if (this.finished) { server.close(); return; }
			const address = server.address();
			if (!address || typeof address === "string") {
				this.finish({ kind: "exec", message: "Bridge has no listening address" });
				return;
			}
			try {
				// Set default text-file encoding independently of the host locale (notably Windows).
				const child = spawn("python3", ["-X", "utf8", "-u", "-c", BOOTSTRAP_SOURCE, String(address.port), token], {
					detached: process.platform !== "win32",
					windowsHide: true,
					cwd: this.options.cwd,
					stdio: ["ignore", "pipe", "pipe"],
				});
				this.child = child;
				child.on("error", (error) => this.finish({ kind: "exec", message: `Failed to start python3: ${errorMessage(error)}` }));
				child.on("exit", (code, signal) => this.finish({
					kind: "exec",
					message: `Python exited before the script settled (${signal ?? code})${this.diagnostics ? `: ${this.diagnostics.trim()}` : ""}`,
				}));
				this.capture(child.stdout);
				this.capture(child.stderr);
			} catch (error) {
				this.finish({ kind: "exec", message: `Failed to start python3: ${errorMessage(error)}` });
			}
		});
	}

	private capture(stream: ChildProcess["stdout"]): void {
		if (!stream) return;
		stream.setEncoding("utf8");
		let partial = "";
		stream.on("data", (chunk: string) => {
			if (this.finished) return;
			this.diagnostics = (this.diagnostics + chunk).slice(-8192);
			partial += chunk;
			if (partial.length > MAX_OUTPUT_CHARS) {
				this.addOutput({ type: "text", text: partial });
				partial = "";
				return;
			}
			const lines = partial.split("\n");
			partial = lines.pop()!;
			for (const line of lines) this.addOutput({ type: "text", text: line.replace(/\r$/, "") });
		});
		stream.on("end", () => { if (partial && !this.finished) this.addOutput({ type: "text", text: partial }); });
	}

	private accept(socket: Socket, token: string): void {
		if (this.finished) { socket.destroy(); return; }
		this.sockets.add(socket);
		socket.on("close", () => this.sockets.delete(socket));
		let buffer: Buffer = Buffer.alloc(0);
		let authenticated = false;
		socket.on("error", (error) => {
			if (socket === this.socket) this.finish({ kind: "exec", message: `Bridge failed: ${errorMessage(error)}` });
		});
		socket.on("end", () => {
			if (socket === this.socket) this.finish({ kind: "exec", message: "Python bridge closed before the script settled" });
		});
		socket.on("data", (chunk: Buffer) => {
			if (this.finished) return;
			buffer = Buffer.concat([buffer, chunk]);
			try {
				if (!authenticated) {
					const newline = buffer.indexOf(10);
					if (newline === -1) {
						if (buffer.length > 65) socket.destroy();
						return;
					}
					if (buffer.subarray(0, newline).toString("ascii") !== token || this.socket) { socket.destroy(); return; }
					authenticated = true;
					this.socket = socket;
					buffer = buffer.subarray(newline + 1);
					// No scripts or pickle values on argv: send them only after the
					// Python version check and cleanup job have succeeded.
					this.post({
						runner: RUNNER_SOURCE,
						code: this.options.code,
						tools: [...this.options.tools.values()].map((tool) => ({
							name: tool.name, alias: toCodemodeIdentifier(tool.name), description: tool.description ?? "",
						})),
						globals: [...this.options.globals.values()].map((global) => ({ name: global.name, spread: global.spread === true })),
						store: this.options.store,
						limits: { outputChars: MAX_OUTPUT_CHARS, outputItems: MAX_OUTPUT_ITEMS, storeValueBytes: MAX_STORE_VALUE_BYTES, storeTotalBytes: MAX_STORE_TOTAL_BYTES },
					});
				}
				while (buffer.length >= 4 && !this.finished) {
					const length = buffer.readUInt32BE(0);
					if (length > MAX_BRIDGE_BYTES) throw new Error("Bridge frame exceeds 64 MiB");
					if (buffer.length < length + 4) break;
					const message: unknown = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
					buffer = buffer.subarray(4 + length);
					this.handleMessage(message);
				}
			} catch (error) {
				this.finish({ kind: "exec", message: `Invalid Python bridge message: ${errorMessage(error)}` });
			}
		});
	}

	private post(message: HostToPythonMessage | Record<string, unknown>): void {
		if (this.finished || !this.socket) return;
		try {
			const body = Buffer.from(JSON.stringify(message));
			if (body.length > MAX_BRIDGE_BYTES) throw new Error("Bridge frame exceeds 64 MiB");
			const header = Buffer.allocUnsafe(4);
			header.writeUInt32BE(body.length);
			this.socket.write(Buffer.concat([header, body]));
		} catch (error) {
			this.finish({ kind: "exec", message: `Bridge write failed: ${errorMessage(error)}` });
		}
	}

	private readonly onAbort = (): void => {
		const reason: unknown = this.signal?.reason;
		this.finish({ kind: "aborted", message: reason instanceof Error ? reason.message : "Execution aborted" });
	};

	private addOutput(item: CodemodeOutputItem): void {
		if (this.finished) return;
		const chars = item.type === "text" ? item.text.length : item.data.length;
		if (this.outputChars + chars > MAX_OUTPUT_CHARS || this.output.length >= MAX_OUTPUT_ITEMS) {
			this.finish({ kind: "script", name: "ValueError", message: "script output exceeded the output limits" });
			return;
		}
		this.outputChars += chars;
		this.output.push(item);
	}

	private handleMessage(value: unknown): void {
		if (typeof value !== "object" || value === null) throw new Error("Expected a message object");
		const message = value as PythonToHostMessage;
		switch (message.type) {
			case "output":
				if (!message.item || !(message.item.type === "text" && typeof message.item.text === "string"
					|| message.item.type === "image" && typeof message.item.data === "string" && typeof message.item.mimeType === "string")) {
					throw new Error("Invalid output item");
				}
				this.addOutput(message.item);
				break;
			case "overflow":
				this.finish({ kind: "script", name: "ValueError", message: "script output exceeded the output limits" });
				break;
			case "call":
				if (!Number.isSafeInteger(message.id) || this.pending.has(message.id) || typeof message.name !== "string"
					|| !["tool", "global"].includes(message.target)) throw new Error("Invalid tool call");
				void this.handleCall(message);
				break;
			case "cancel":
				this.cancelCall(message.id);
				break;
			case "done":
				if (message.ok === true) {
					if (!message.writes || typeof message.writes !== "object" || Array.isArray(message.writes)) throw new Error("Invalid store writes");
					this.finish(undefined, message.value, parseStoreWrites(message.writes));
				} else if (message.ok === false && message.error && typeof message.error.message === "string") {
					this.finish({ ...message.error, kind: "script" });
				} else throw new Error("Invalid execution result");
				break;
			default: throw new Error("Unknown Python bridge message");
		}
	}

	private cancelCall(id: number): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		if (pending.record) pending.record.durationMs = performance.now() - pending.startedAt;
		pending.controller.abort();
	}

	private async handleCall(message: Extract<PythonToHostMessage, { type: "call" }>): Promise<void> {
		const { id, name } = message;
		const isTool = message.target === "tool";
		const record: CodemodeCall | undefined = isTool ? { name, status: "cancelled", durationMs: 0 } : undefined;
		if (record) this.calls.push(record);
		const pending: PendingCall = { record, startedAt: performance.now(), controller: new AbortController() };
		this.pending.set(id, pending);
		let reply: HostToPythonMessage;
		let status: "ok" | "error";
		try {
			const tool = (isTool ? this.options.tools : this.options.globals).get(name);
			if (!tool) throw new Error(`Unknown ${isTool ? "tool" : "global"} "${name}"`);
			const value = await tool.execute(message.args, { signal: pending.controller.signal });
			// Host undefined is JSON null; all other results must survive JSON serialization.
			const json = JSON.stringify(value === undefined ? null : value);
			if (json === undefined) throw new TypeError("Tool result is not JSON-serializable");
			reply = { type: "result", id, ok: true, value: JSON.parse(json) };
			status = "ok";
		} catch (error) {
			reply = { type: "result", id, ok: false, message: errorMessage(error) };
			status = "error";
		}
		if (!this.pending.delete(id)) return;
		if (record) { record.status = status; record.durationMs = performance.now() - pending.startedAt; }
		this.post(reply);
	}

	private finish(error: CodemodeError | undefined, value?: unknown, writes?: CodemodeStoreWrites): void {
		if (this.finished) return;
		this.finished = true;
		clearTimeout(this.timer);
		this.signal?.removeEventListener("abort", this.onAbort);
		for (const id of this.pending.keys()) this.cancelCall(id);
		const result: CodemodeResult = error
			? { ok: false, error, output: this.output, calls: this.calls }
			: { ok: true, value, output: this.output, calls: this.calls, storeWrites: writes ?? { set: {}, delete: [] } };
		this.server?.close();
		// Keep the bridge open during normal cleanup: on POSIX, closing it first
		// would invoke the host-death watchdog's immediate group SIGKILL instead
		// of giving descendants their graceful termination window.
		void this.terminate().then(() => {
			for (const socket of this.sockets) socket.destroy();
			this.resolveResult(result);
		});
	}

	private async terminate(): Promise<void> {
		const child = this.child;
		if (!child?.pid) return;
		const pid = child.pid;
		if (process.platform === "win32") {
			// TerminateProcess closes the runner's non-inherited Job Object handle,
			// causing the OS to terminate all descendants in the job.
			child.kill();
			await new Promise<void>((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
				const timer = setTimeout(resolve, 500);
				child.once("exit", () => { clearTimeout(timer); resolve(); });
			});
		} else {
			const killGroup = (signal: NodeJS.Signals) => { try { process.kill(-pid, signal); } catch { /* already gone */ } };
			killGroup("SIGTERM");
			await new Promise((resolve) => setTimeout(resolve, 100));
			// Kill the group even if the root has already exited: descendants may
			// ignore SIGTERM, and root exit alone is not proof of tree cleanup.
			killGroup("SIGKILL");
		}
		child.stdout?.destroy();
		child.stderr?.destroy();
	}
}

/** Runs trusted Python with tool access in a fresh system process per execution. */
export class CodemodeExecutionEnv {
	private readonly toolsByName = new Map<string, CodemodeTool>();
	private readonly globalsByName = new Map<string, CodemodeTool>();
	private readonly timeoutMs: number;
	private readonly cwd: string | undefined;
	private readonly running = new Set<Execution>();
	private closed = false;

	constructor(options: CodemodeExecutionEnvOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.cwd = options.cwd;
		for (const tool of options.tools ?? []) this.registerTool(tool);
		validateGlobalNames(options.globals ?? []);
		for (const global of options.globals ?? []) {
			this.globalsByName.set(global.name, global);
		}
	}

	registerTool(tool: CodemodeTool): void {
		validateToolNames([...this.toolsByName.values(), tool]);
		this.toolsByName.set(tool.name, tool);
	}

	unregisterTool(name: string): boolean { return this.toolsByName.delete(name); }
	get tools(): CodemodeTool[] { return [...this.toolsByName.values()]; }
	get globals(): CodemodeTool[] { return [...this.globalsByName.values()]; }

	execute(code: string, options: CodemodeExecuteOptions = {}): Promise<CodemodeResult> {
		if (this.closed) return Promise.reject(new Error("Execution environment is closed"));
		let store: Record<string, string>;
		try { store = serializeStore(options.store); }
		catch (error) { return Promise.resolve({ ok: false, error: { kind: "exec", message: errorMessage(error) }, output: [], calls: [] }); }
		const execution = new Execution({
			cwd: this.cwd,
			code, tools: new Map(this.toolsByName), globals: this.globalsByName,
			timeoutMs: options.timeoutMs ?? this.timeoutMs, signal: options.signal, store,
		});
		this.running.add(execution);
		return execution.promise.finally(() => this.running.delete(execution));
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.running].map((execution) => execution.abort("Execution environment closed")));
	}
}
