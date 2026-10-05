# pi-codemode-py

Runs model-written Python in the unsandboxed system python runtime. In addition to normal std python 
libraries, Pi tools that are codemode-exposed are injected into the available context along with some helper 
functions that enable tool discovery and soft REPL-like persistence across script executions.

Direct tool call outputs do not enter the LLM context; only the script's output and return value do.

Scripts use `tools`, `ALL_TOOLS`, `text`, `image`, `exit`, `store`, and `load`, and may start with a `# @options:` line.

## Repo Structure

```text
packages/
├── codemode-py/          # Runtime package: source, tests, and build configuration
└── extensions/
    └── codemode/        # Pi coding-agent extension
```

## Architecture

This extension follows most of the overall architecture of the bundled pi codemode extension as closely as 
possible, but differs in the key choice to have the execution environment not be sandboxed and instead to
just run a trusted script using system python. `store` and `load` also save native python values using the 
python-native pickle format instead of json, but most other uses of json stay.

The host API remains TypeScript. Requires Node.js 22.19+ and `python3` 3.12+ on PATH.

Install dependencies and build with `npm ci` at the repository root. Add `+codemode` to Pi's
`defaultTools` setting and load the local package with `pi -e .`. Avoid `--tools codemode`: that
allowlist also excludes the other tools from nested calls.
The extension replaces Pi's bundled `codemode` tool and is registered inactive, like the bundled version.
The installable adapter package is `@fu5ha/pi-codemode-py-extension`.

## Usage

```ts
import { CodemodeExecutionEnv } from "@fu5ha/pi-codemode-py";

const env = new CodemodeExecutionEnv({
	timeoutMs: 60_000,
	tools: [
		{
			name: "read",
			execute: async (args, { signal }) => {
				const { path } = args as { path: string };
				return await readFile(path, "utf8");
			},
		},
	],
});

const result = await env.execute(`
import json

source = await tools.read({"path": "package.json"})
text(f"bytes {len(source.encode('utf-8'))}")
return json.loads(source)["name"]
`);

console.log(result.output); // [{ type: "text", text: "bytes 1234" }]
if (result.ok) console.log(result.value); // "@fu5ha/pi-codemode-py"
else console.error(result.error.kind, result.error.message);

await env.close();
```

`code` is the body of an async (asyncio) function: `return` and top-level `await` work. Inside the script:

- `tools.<name>(args)` is awaited to get a result. Arguments and results make a JSON round trip. Tool failures raise `RuntimeError` carrying the host error message.
- Tool names have Python-safe attribute aliases: invalid characters become `_`, leading digits are prefixed with `_`, and keywords are suffixed with `_`. `tools["original-name"]` provides exact-name lookup. Alias collisions and reserved namespace attributes are rejected at registration so discovery stays unambiguous.
- `ALL_TOOLS` lists `{"name": ..., "description": ...}` for every tool, with `name` as the identifier.
- `text(value)` appends a text item to `result.output`.
- Output conversion leaves strings unchanged, JSON-encodes JSON-compatible values, and falls back to `repr()` for other Python values. Python stdout/stderr are captured as line-buffered text items, with partial lines flushed at completion, so `print()` and ordinary diagnostics are visible. Bridge traffic uses a separate channel. Python stream redirection alone does not capture native code or subprocess output.
- `image(urlOrItem)` appends an image item. It accepts a base64 `data:` URL, `{"image_url": url}`, or an MCP `ImageContent` block (`{"type": "image", "data": data, "mimeType": mime_type}`). Remote URLs are rejected.
- `exit()` ends the script successfully right away, keeping its output and store writes.
- `globals` passed to the execution environment are called as top-level functions, for example a host helper `image(ref)`. They behave like tools but are not recorded in `result.calls`. A name like `models.classify` puts the function on an ordinary Python namespace. With `spread: true`, the host's `execute` receives all call arguments as an array instead of the first one, and `signature` replaces the declaration generated from the schemas. These namespaces need not reproduce JavaScript's frozen objects in an explicitly trusted execution environment.
- `store(key, value)` and `load(key)` read and write pickle values synchronously. See [Store](#store).

`timeoutMs: Infinity` disables the host deadline; the script then runs until it completes or `signal` aborts it. There is no unsettled-promise detector: system Python has timers and I/O, so absence of pending tool calls does not imply a deadlocked script.

## Store

`store`/`load` let scripts keep values across executions. The execution environment does not persist anything itself: pass the current values as `options.store`, and a successful result reports what the script changed as `result.storeWrites` (`{ set, delete }`). Failed executions report no writes.

```ts
const result = await env.execute(`
runs = load("runs")
store("runs", (0 if runs is None else runs) + 1)
`, { store: saved });
if (result.ok) {
	for (const key of result.storeWrites.delete) delete saved[key];
	Object.assign(saved, result.storeWrites.set);
}
```

`load` returns a copy, so mutating it does not change the store. Oversized writes raise `ValueError`.

`store(key, None)` deletes, and `load(key)` returning `None` means the key did not exist. There is
no way to store `None` explicitly.

Measures serialized pickle bytes before base64 transport, with maximum store sizes of 256 KiB per value and
2 MiB total.

## Source format

`parseCodemodeSource()` accepts a script whose first line may be an options line:

```python
# @options: {"max_output_tokens": 2000, "timeout_ms": 30000}
import json

source = await tools.read({"path": "package.json"})
text(json.loads(source)["name"])
```

Supported fields are `max_output_tokens`, a token budget for the output, and `timeout_ms`, a hard deadline. The execution env itself does not act on them. Instead, it is parsed and enforced at the host extension level. The options line is replaced by an empty line, so line numbers in stack traces still match the input. 

Empty input, invalid JSON, unknown fields, or an options line without code throw `CodemodeSourceError`. `CODEMODE_SOURCE_GRAMMAR` is a Lark grammar for providers that support grammar-constrained tool input.

Both are also available from the lightweight `@fu5ha/pi-codemode-py/source` entry.

## Declarations for the model

Tools and globals can carry `description`, `inputSchema`, and `outputSchema` (JSON Schema). `renderDeclarations()` generates Python-facing signatures and type hints instead of TypeScript declarations, for example:

```ts
renderDeclarations({ tools: env.tools, globals: env.globals });
```

```python
from typing import TypedDict

class ReadArgs(TypedDict):
    path: str

class Tools:
    async def read(self, args: ReadArgs) -> str:
        """Read a file."""
        ...
```

Schemas only shape the declarations; values are not validated against them. Local references (`#/$defs/...`, `#/definitions/...`) are expanded; recursive and remote references render as `Any` from `typing`. The example illustrates the shape; actual output uses deterministic functional `TypedDict` definitions.

## Using with pi-agent-core

To give an `Agent` a codemode tool, expose its other tools to the execution environment and wrap `execute()` as an `AgentTool`:

```ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type CodemodeJsonSchema,
	CodemodeExecutionEnv,
	type CodemodeTool,
	renderDeclarations,
} from "@fu5ha/pi-codemode-py";
import { Type } from "typebox";

const codemodeTools: CodemodeTool[] = agentTools.map((tool) => ({
	name: tool.name,
	description: tool.description,
	inputSchema: tool.parameters as CodemodeJsonSchema,
	outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? { type: "string" },
	execute: async (args, { signal }) => {
		const result = await tool.execute("nested", args as never, signal);
		if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
		return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	},
}));

const codemodeTool: AgentTool = {
	name: "codemode",
	label: "Codemode",
	description: `Run Python that calls tools as \`await tools.<name>(args)\`. Output with text() or return.\n\n${renderDeclarations({ tools: codemodeTools })}`,
	parameters: Type.Object({ code: Type.String() }),
	execute: async (_toolCallId, { code }, signal) => {
		const env = new CodemodeExecutionEnv({ tools: codemodeTools });
		try {
			const result = await env.execute(code, { signal });
			const content = [...result.output];
			if (result.ok && result.value !== undefined) content.push({ type: "text", text: JSON.stringify(result.value) });
			if (!result.ok) content.push({ type: "text", text: result.error.stack ?? result.error.message });
			return { content, details: undefined, isError: !result.ok };
		} finally {
			await env.close();
		}
	},
};
```

`result.output` items already have the shape of `@earendil-works/pi-ai`'s `TextContent` and `ImageContent`. Calling `tool.execute()` directly skips the agent's `beforeToolCall` and `afterToolCall` hooks. To apply them to nested calls too, run each call through `runToolCall()` from `@earendil-works/pi-agent-core`, as the [mcp-codemode example](https://github.com/earendil-works/pi/tree/main/packages/agent/examples/mcp-codemode) does. That example also rejects failed nested calls inside the script and combines codemode with MCP tools.

## Results

`execute()` never rejects for script failures. `result.error.kind` is one of:

| kind      | meaning                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `script`  | the script raised an exception or failed to parse; `stack` contains a Python traceback with `codemode.py` source locations |
| `timeout` | the deadline expired; the execution backend was terminated                   |
| `aborted` | `options.signal` fired or `close()` was called; the execution backend was terminated |
| `exec`    | the execution backend failed, for example Python startup or bridge transport failure |

`result.output` holds the text and image items in the order the script produced them, also for failed executions. The host keeps all of it until the script ends, so output is limited to `MAX_OUTPUT_CHARS` (16 Mi) characters of text and base64 image data and `MAX_OUTPUT_ITEMS` (100000) items. Exceeding either limit raises `ValueError` and marks the execution failed on the host even if the script catches the exception. `result.calls` lists every tool call with `status: "ok" | "error" | "cancelled"`.

Async tool wrappers start calls only when awaited or scheduled, following normal Python coroutine semantics. When the main script returns, outstanding tasks are cancelled, their host calls are aborted through `signal`, and those calls are reported as `cancelled`. An unawaited, unscheduled coroutine never starts a call and is not recorded. Cleanup has a bounded deadline because tasks can suppress `CancelledError`. Cancellation cannot undo remote side effects that already occurred.

## How it works

Each `execute()` starts a Python process. The execution environment uses system python, and is
intentionally not sandboxed.

The script is compiled as an async Python function body with access to `tools` and the helper functions. Use `codemode.py` as the compile filename and adjust wrapper line offsets so tracebacks match the submitted source.

Each execution uses a separate Python process with a dedicated framed JSON IPC channel for tool requests/results and pickle only for store values. Process isolation keeps blocking Python work off the host and permits hard termination, at the cost of process startup overhead. On timeout or abort, the host cancels tool calls and terminates the process tree, escalating to a forced kill after a short grace period. Descendants are managed through POSIX process groups or Windows Job Objects as appropriate. This is lifecycle management, not a security sandbox.

The process keeps script execution off the host thread: a spinning script does not block the host.
