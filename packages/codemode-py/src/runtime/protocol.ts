import type { CodemodeOutputItem } from "../types.ts";

/** Language-neutral execution data; worker startup is backend-specific. */
export interface WorkerData {
	code: string;
	tools: { name: string; scriptName: string; description: string }[];
	globals: { name: string; spread: boolean }[];
	/** Snapshot for load(): key to base64-encoded serialized bytes. */
	store: Record<string, string>;
	limits: {
		outputChars: number;
		outputItems: number;
		/** Serialized byte limits, measured before base64 encoding. */
		storeValueBytes: number;
		storeTotalBytes: number;
	};
}

/** JSON-encoded { name?, message, stack?, diagnostics? } of a script error. */
export type ScriptErrorJson = string;

/** Dedicated framed JSON bridge; payloads are themselves JSON strings. */
export type WorkerToHostMessage =
	| { type: "call"; id: number; target: "tool" | "global"; name: string; args: string }
	| { type: "cancel"; id: number }
	| { type: "output"; item: CodemodeOutputItem }
	| { type: "overflow" }
	| {
			type: "done";
			ok: true;
			/** JSON-encoded return value, including "null". */
			value: string;
			/** JSON array of [key, base64] writes and [key] deletions. */
			writes: string;
	  }
	| { type: "done"; ok: false; error: ScriptErrorJson }
	| { type: "crash"; message: string };

/** payload is the JSON result when ok, otherwise the error message. */
export type HostToWorkerMessage = { type: "result"; id: number; ok: boolean; payload: string };

/** Kind guards only; handlers validate the fields before using them. */
export function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return type === "call" || type === "cancel" || type === "output"
		|| type === "overflow" || type === "done" || type === "crash";
}

export function isHostToWorkerMessage(value: unknown): value is HostToWorkerMessage {
	return typeof value === "object" && value !== null
		&& (value as { type?: unknown }).type === "result";
}
