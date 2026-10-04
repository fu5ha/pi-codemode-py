import type { CodemodeError, CodemodeOutputItem } from "../types.ts";

/** Dedicated length-prefixed JSON bridge, independent of stdout and stderr. */
export type PythonToHostMessage =
	| { type: "call"; id: number; target: "tool" | "global"; name: string; args: unknown }
	| { type: "cancel"; id: number }
	| { type: "output"; item: CodemodeOutputItem }
	| { type: "overflow" }
	| { type: "done"; ok: true; value: unknown; writes: Record<string, string | null> }
	| { type: "done"; ok: false; error: Omit<CodemodeError, "kind"> };

export type HostToPythonMessage =
	| { type: "result"; id: number; ok: true; value: unknown }
	| { type: "result"; id: number; ok: false; message: string };
