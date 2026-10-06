/**
 * The `codemode` tool: the model writes Python that calls other tools. Scripts use `tools`,
 * `ALL_TOOLS`, `text()`, `image()`, `exit()`, `store()`/`load()`, `print()`, and `return <value>`,
 * may start with a `# @options:` line, and reach the model catalog, classifiers, and image models
 * through `models.*`. Results start with a "Script completed" or "Script failed" header.
 *
 * Scripts can call the agent loop's nested tools: active `direct` tools and every `codemode` or
 * `deferred` tool. Nested calls run through the agent loop's tool pipeline (`ctx.executeTool`), so
 * validation, `tool_call`/`tool_result` hooks, and permission checks apply exactly as for direct
 * calls. Only the script's output reaches the model; nested results do not.
 *
 * Nested results are handed to the script as follows:
 * - A tool that declares `outputSchema` resolves to its `structuredContent`, also for error
 *   results that carry one (MCP tools resolve to their `CallToolResult`, including `isError`).
 * - Any other tool resolves to its text content as one string.
 * - A failed, blocked, or invalid call rejects with an Error carrying the tool's error text.
 *
 * A script that fails returns a normal error result that keeps its partial output, followed by
 * "Script error:" and the error. `store(key, value)` and `load(key)` keep pickle values across
 * calls; successful scripts append base64 writes to versioned `codemode-py-store` custom entries,
 * so each branch sees the values written on its own path.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CodemodeError, CodemodeJsonSchema, CodemodeTool } from "@fu5ha/pi-codemode-py";
import {
	MCP_PYTHON_PREAMBLE,
	mcpStructuredContentSchema,
	renderToolOutputType,
	renderToolSample,
	toCodemodeIdentifier,
} from "@fu5ha/pi-codemode-py/declarations";
import { CODEMODE_SOURCE_GRAMMAR } from "@fu5ha/pi-codemode-py/source";
import { type Static, Type } from "typebox";
import type {
	ToolDefinition,
	ToolInfo,
	ToolLoadout,
	ToolLoadoutChanges,
	ToolNamespace,
} from "@earendil-works/pi-coding-agent";
import type { ModelRegistry, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { loadCodemodeExecutor } from "./execute.lazy.ts";
import { codemodeRenderers } from "./renderer.ts";

export const CODEMODE_TOOL_NAME = "codemode";

/** Custom entry type holding one script's `store()` writes: {@link CodemodeStoreEntryData}. */
export const CODEMODE_STORE_ENTRY_TYPE = "codemode-py-store";

export type CodemodeMode = "on" | "only";

export interface CodemodeStoreEntryData {
	version: 1;
	encoding: "pickle-base64";
	set: Record<string, string>;
	delete: string[];
}

/** The part of the model registry that scripts reach through `models`. */
export type CodemodeModelRuntime = Pick<
	ModelRegistry,
	"getModelsOfType" | "getAvailableOfType" | "getModelOfType" | "classify" | "generateImages"
>;

export interface CodemodeToolOptions {
	/** Namespace of a tool, for `searchTools()` ranking and its `namespace` filter. */
	getToolNamespace?: (toolName: string) => ToolNamespace | undefined;
	/**
	 * Expose the `models` namespace to scripts, backed by the session's model registry
	 * (`ctx.modelRegistry`). Without it, `models` is not declared.
	 */
	models?: boolean;
	/**
	 * Persists `store()` writes as a session custom entry. Without it, writes last only for the
	 * current script; `load()` still reads entries already on the branch.
	 */
	appendEntry?: (customType: string, data: CodemodeStoreEntryData) => void;
	/** How the tool presents the loadout while active (the `codemode.mode` setting). Default: `on`. */
	getMode?: () => CodemodeMode;
	/** Token budget for tool declarations in the description. Default: {@link DEFAULT_CODEMODE_INLINE_BUDGET}. */
	getInlineBudget?: () => number | undefined;
}

const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

export const codemodeSchema = Type.Object({
	code: Type.String({
		description: "Raw Python source.",
	}),
});

export type CodemodeToolInput = Static<typeof codemodeSchema>;

/**
 * Whether a registered tool is this package's `codemode` tool rather than another extension's tool
 * with the same name. Compares the parameter schema, which the definition passes through by reference.
 */
export function isCodemodeTool(tool: Pick<ToolInfo, "name" | "parameters">): boolean {
	return tool.name === CODEMODE_TOOL_NAME && tool.parameters === codemodeSchema;
}

export type CodemodeNestedCallStatus = "running" | "ok" | "error" | "cancelled";

export interface CodemodeNestedCall {
	/** Tool call id of the nested call, `<codemode call id>/<n>`. */
	id: string;
	name: string;
	/** Compact JSON of the arguments, truncated for display. */
	args: string;
	status: CodemodeNestedCallStatus;
	durationMs?: number;
	/** Error text, truncated for display. */
	error?: string;
	/** Cost in USD of a `models.*` call that reported usage. */
	cost?: number;
}

export interface CodemodeToolDetails {
	calls: CodemodeNestedCall[];
	/** Failure presentation is independent of the model-facing output budget. */
	failure?: {
		error: CodemodeError;
		durationMs: number;
		/** Budgeted ordinary output, excluding the appended traceback. Images are markers only. */
		output: { type: "text" | "image"; text?: string }[];
	};
	/** Temp file with the full text output, when the output was truncated. */
	fullOutputPath?: string;
}

export const codemodeToolSystemPromptContribution = {
	snippet: "Run trusted Python that calls other tools",
	guidelines: [
		"Use codemode to batch independent tool calls with asyncio.gather(..., return_exceptions=True), chain them, or filter large output.",
	],
} as const;

/** The reference for scripts: globals, tool results, `store()`, the `models` API, and limits. */
export const CODEMODE_DOCS_PATH = "the Python interface described in this tool";

const DESCRIPTION_INTRO = `Run trusted, unsandboxed Python using python3 (3.12+). Input is raw Python (not JSON, no code fence), run as an async function body: top-level \`await\` and \`return\` work. Standard libraries, filesystem, network, and timers are available.
- \`await tools.<name>({"key": value})\` returns text or structured JSON according to its declaration. Failures raise RuntimeError. Exact-name lookup: \`tools["original-name"]\`. Calls still running when the script ends are cancelled; side effects are not undone.
- Injected host functions accept positional arguments only, not Python keyword arguments. Pass tool arguments and helper options as dictionaries.
- Optional first line: \`# @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\``;

/** One line per global. The details live in {@link CODEMODE_DOCS_PATH}. */
function describeGlobals(models: boolean): string {
	const lines = [
		"Globals:",
		"- `text(value)`, `image(dataUrlOrImageBlock)`, and `print(...)` add output; `exit()` ends the script. Returns must be JSON-compatible; None becomes JSON null at every level, including implicit returns and exit(). text() falls back to repr(). image() accepts base64 data URLs or image blocks and saves them to a temp file.",
		"- `store(key, value)` and `load(key)` keep native Python pickle values across successful calls on the current session branch. load() returns a copy; missing keys return None; store(key, None) deletes. Limits: 256 KiB per serialized value, 2 MiB total before base64.",
		"- `ALL_TOOLS`, `await searchTools(query, {\"limit\": 8, \"namespace\": \"name\"})`, `await describeTool(name)`, `await describeNamespace(name)`: find unlisted tools, such as MCP tools. Returned names are callable Python aliases; use `getattr(tools, entry[\"name\"])(args)` for dynamic calls. Bracket lookup uses the original tool name.",
	];
	if (models) {
		lines.push(`- \`models\`: all functions are awaited and positional-only. getModelsOfType(type, provider), getAvailableOfType(type, provider), getModelOfType(type, provider, id); provider can be omitted or passed as None positionally for the first two, e.g. \`await models.getModelsOfType("image", None)\`. type is "chat", "classifier", or "image". classify(model, {"state": {...}, "questions": {"id": {"type": "bool", "instructions": "...", "criteria": {"true": "...", "false": "..."}}}}) returns answers by ID; choice criteria map labels to meanings; score criteria list levels. generateImages(model, {"input": [{"type": "text", "text": "..."}]}) returns output blocks: show image blocks with image(block). Model is a catalog entry or {"provider": "...", "id": "..."}. Check result["stopReason"] ("stop", "error", "aborted") and errorMessage. At most four classify/image calls run concurrently. Usage contributes to session totals.`);
	}
	return lines.join("\n");
}

/** Default for {@link CodemodeDescriptionOptions.inlineBudget}, in estimated tokens. */
export const DEFAULT_CODEMODE_INLINE_BUDGET = 3000;
/** Characters per token when estimating the cost of a tool section. */
const CHARS_PER_TOKEN = 4;

/** What a script sees of a tool. Tools without an output schema resolve to their text output. */
export function toCodemodeDeclaration(tool: AgentTool<any>): Omit<CodemodeTool, "execute"> {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as CodemodeJsonSchema,
		outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? TEXT_OUTPUT_SCHEMA,
	};
}

/** Tools a script may call: every given tool except the codemode tool itself. */
export function getCodemodeCallableTools(tools: readonly AgentTool<any>[]): AgentTool<any>[] {
	return tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
}

export interface CodemodeDescriptionOptions {
	/** Declare the `models` namespace; only for tools created with model access. */
	models?: boolean;
	/** Namespace of each tool, by tool name. Tools of one namespace are listed under one heading. */
	namespaces?: ReadonlyMap<string, ToolNamespace>;
	/** Tools that are callable but never listed with their declaration (`deferred` exposure). */
	deferred?: ReadonlySet<string>;
	/**
	 * Estimated tokens (characters / 4) the tool sections may use. Tools that do not fit are left
	 * out, like deferred tools. Unset lists every tool that is not deferred.
	 */
	inlineBudget?: number;
}

/** `### \`id\` (\`raw name\`)` followed by the tool's description and declaration. */
function renderToolSection(declaration: Omit<CodemodeTool, "execute">): string {
	const id = toCodemodeIdentifier(declaration.name);
	const heading = id === declaration.name ? `### \`${id}\`` : `### \`${id}\` (\`${declaration.name}\`)`;
	return `${heading}\n${renderToolSample(declaration).trim()}`;
}

interface CatalogEntry {
	name: string;
	section: string;
	cost: number;
}

interface CatalogGroup {
	namespace: ToolNamespace | undefined;
	entries: CatalogEntry[];
}

/**
 * Pick the tool sections that fit the budget, like OpenCode's catalog: in each round every group
 * (tools without a namespace first, then namespaces by name) places its cheapest remaining tool; a
 * group whose next tool does not fit drops out while the others continue. Every namespace is
 * represented before any namespace is complete.
 */
function selectCatalog(groups: readonly CatalogGroup[], budget: number | undefined): Set<string> {
	if (budget === undefined) return new Set(groups.flatMap((group) => group.entries.map((entry) => entry.name)));
	const queues = groups.map((group) => [...group.entries].sort((a, b) => a.cost - b.cost));
	const shown = new Set<string>();
	let remaining = budget;
	let active = queues.filter((queue) => queue.length > 0);
	while (active.length > 0) {
		active = active.filter((queue) => {
			const next = queue[0];
			if (next.cost > remaining) return false;
			remaining -= next.cost;
			shown.add(next.name);
			queue.shift();
			return queue.length > 0;
		});
	}
	return shown;
}

/**
 * Model-facing description: the helper list, guidance for finding tools that are not listed, the
 * shared MCP types when listed tools need them, the `models` API, and one section per listed tool,
 * grouped by namespace. Deferred tools are never listed and do not affect the description at all, so
 * it stays the same while MCP servers connect or change their tools. Tool sections are limited to
 * `inlineBudget`.
 */
export function createCodemodeDescription(
	tools: readonly AgentTool<any>[],
	options: CodemodeDescriptionOptions = {},
): string {
	const declarations = getCodemodeCallableTools(tools)
		.filter((tool) => !options.deferred?.has(tool.name))
		.map(toCodemodeDeclaration);
	const groups = new Map<string, CatalogGroup>([["", { namespace: undefined, entries: [] }]]);
	for (const declaration of declarations) {
		const namespace = options.namespaces?.get(declaration.name);
		const key = namespace ? `ns:${namespace.name}` : "";
		const group = groups.get(key) ?? { namespace, entries: [] };
		groups.set(key, group);
		const section = renderToolSection(declaration);
		group.entries.push({ name: declaration.name, section, cost: Math.ceil(section.length / CHARS_PER_TOKEN) });
	}
	const ordered = [...groups.values()].sort((a, b) =>
		a.namespace === undefined ? -1 : b.namespace === undefined ? 1 : a.namespace.name.localeCompare(b.namespace.name),
	);
	const shown = selectCatalog(ordered, options.inlineBudget);

	const sections = [DESCRIPTION_INTRO, describeGlobals(options.models === true)];
	if (
		declarations.some(
			(declaration) =>
				shown.has(declaration.name) && mcpStructuredContentSchema(declaration.outputSchema) !== undefined,
		)
	) {
		sections.push(`Shared MCP Types:\n\`\`\`python\n${MCP_PYTHON_PREAMBLE}\n\`\`\``);
	}
	if (declarations.length === 0) return sections.join("\n\n");

	const toolSections = ["Nested tools:"];
	for (const { namespace, entries } of ordered) {
		const visible = entries.filter((entry) => shown.has(entry.name));
		if (namespace) {
			// Only tools that did not fit the budget are counted as not listed here.
			const listing =
				visible.length === entries.length
					? ""
					: visible.length === 0
						? " (tools not listed)"
						: " (some tools not listed)";
			const description = namespace.description?.trim();
			toolSections.push(`## ${namespace.name}${listing}${description ? `\n${description}` : ""}`);
		}
		for (const entry of visible) toolSections.push(entry.section);
	}
	sections.push(toolSections.join("\n\n"));
	return sections.join("\n\n");
}

/**
 * What a script call resolves to, in one line: `a string`, the field names of an object
 * (`{ output, exit_code, full_output_path? }`), or the rendered type for anything else.
 */
function describeOutput(schema: CodemodeJsonSchema | undefined): string {
	const type = renderToolOutputType(schema);
	if (type === "str") return "a string";
	const object = typeof schema === "object" ? schema : undefined;
	const properties = object?.properties;
	if (
		object?.type === "object" &&
		typeof properties === "object" &&
		properties !== null &&
		mcpStructuredContentSchema(schema) === undefined
	) {
		const required = new Set(Array.isArray(object.required) ? object.required : []);
		const fields = Object.keys(properties).map((name) => (required.has(name) ? name : `${name}?`));
		return `\`{ ${fields.join(", ")} }\``;
	}
	return `\`${type.replace(/\s+/g, " ")}\``;
}

/**
 * A declared tool's description followed by how scripts call it and what the call resolves to. The
 * arguments are the tool's declared parameters, so they are not repeated.
 */
function describeScriptCall(tool: AgentTool<any>): string {
	return `${tool.description.trim()}\n\nCodemode: \`await tools.${toCodemodeIdentifier(tool.name)}(args)\` returns ${describeOutput(toCodemodeDeclaration(tool).outputSchema)}.`;
}

/**
 * How the codemode tool presents tools that are both declared and callable from scripts:
 * - `on`: their descriptions say how scripts call them, and the codemode description
 *   lists only the callable tools without `direct` exposure.
 * - `only`: the codemode description lists every callable tool, and requests leave out the
 *   declarations of active `direct` tools.
 *
 * Listing by exposure, not by the active set, keeps the codemode description unchanged when
 * `tool_search` loads a tool, so loads do not redeclare codemode.
 */
function prepareCodemodeLoadout(loadout: ToolLoadout, options: CodemodeToolOptions): ToolLoadoutChanges {
	const mode = options.getMode?.() ?? "on";
	const isDirect = (tool: AgentTool) => loadout.getExposure(tool.name) === "direct";
	const callable = getCodemodeCallableTools(loadout.callable);
	const callableNames = new Set(callable.map((tool) => tool.name));
	const descriptions: Record<string, string> = {};
	if (mode === "on") {
		for (const tool of loadout.declared) {
			if (callableNames.has(tool.name)) descriptions[tool.name] = describeScriptCall(tool);
		}
	}
	const listed = mode === "only" ? callable : callable.filter((tool) => !isDirect(tool));
	const namespaces = new Map(
		listed.flatMap((tool) => {
			const namespace = loadout.getNamespace(tool.name);
			return namespace ? [[tool.name, namespace] as const] : [];
		}),
	);
	descriptions[CODEMODE_TOOL_NAME] = createCodemodeDescription(listed, {
		models: options.models === true,
		namespaces,
		deferred: new Set(
			listed.filter((tool) => loadout.getExposure(tool.name) === "deferred").map((tool) => tool.name),
		),
		inlineBudget: options.getInlineBudget?.() ?? DEFAULT_CODEMODE_INLINE_BUDGET,
	});
	const declaredNames = new Set(loadout.declared.map((tool) => tool.name));
	return {
		descriptions,
		hiddenDeclarations:
			mode === "only"
				? callable.filter((tool) => isDirect(tool) && declaredNames.has(tool.name)).map((tool) => tool.name)
				: [],
	};
}

export function createCodemodeToolDefinition(
	options: CodemodeToolOptions = {},
): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails | undefined> {
	return {
		name: CODEMODE_TOOL_NAME,
		label: CODEMODE_TOOL_NAME,
		// Replaced with the declarations of the callable tools when the tool is activated.
		description: createCodemodeDescription([], { models: options.models === true }),
		promptSnippet: codemodeToolSystemPromptContribution.snippet,
		promptGuidelines: [...codemodeToolSystemPromptContribution.guidelines],
		parameters: codemodeSchema,
		// Scripts must not start other scripts.
		exposure: "model-only",
		executionMode: "sequential",
		prepareLoadout: (loadout) => prepareCodemodeLoadout(loadout, options),
		// Capable models write the script as raw text instead of a JSON-escaped string.
		constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		// Python runtime code loads on the first call; no process starts at extension load time.
		execute: async (toolCallId, params, signal, onUpdate, ctx) =>
			(await loadCodemodeExecutor()).executeCodemode(toolCallId, params, signal, onUpdate, ctx, options),
		...codemodeRenderers,
	};
}

/**
 * Create the codemode tool as an AgentTool. The description lists the given tools; the script can
 * call whatever tools the agent loop provides at execution time.
 */
export function createCodemodeTool(
	tools: readonly AgentTool<any>[] = [],
	options: CodemodeToolOptions = {},
): AgentTool<typeof codemodeSchema> {
	const definition = createCodemodeToolDefinition(options);
	// Plain Agent calls have no Pi context: do not bypass Pi's nested-tool pipeline.
	const tool: AgentTool<typeof codemodeSchema> = {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		constrainedSampling: definition.constrainedSampling,
		executionMode: definition.executionMode,
		execute: (id, params, signal, onUpdate, ctx?: ExtensionToolContext) =>
			definition.execute(id, params, signal, onUpdate, ctx as ExtensionToolContext),
	};
	Object.assign(tool, {
		description: createCodemodeDescription(tools, { models: options.models === true }),
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
