/** Lazy-loaded adapter for one trusted Python execution. */

import type { AgentTool, AgentToolCallOutcome, AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	AnyModel,
	ClassifierContext,
	ImageContent,
	ImagesContext,
	ModelType,
	ModelTypeMap,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai";
import {
	type CodemodeResult,
	CodemodeExecutionEnv,
	type CodemodeTool,
	parseCodemodeSource,
	renderToolSample,
	toCodemodeIdentifier,
} from "@fu5ha/pi-codemode-py";
import { formatSize, type ExtensionToolContext, type ToolNamespace, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { combineUsage, writeOutputFile } from "./utilities.ts";
import { Bm25Ranker, createToolSearchDocument, DEFAULT_TOOL_SEARCH_LIMIT } from "./search.ts";
import {
	CODEMODE_DOCS_PATH,
	CODEMODE_STORE_ENTRY_TYPE,
	type CodemodeModelRuntime,
	type CodemodeNestedCall,
	type CodemodeStoreEntryData,
	type CodemodeToolDetails,
	type CodemodeToolInput,
	type CodemodeToolOptions,
	getCodemodeCallableTools,
	toCodemodeDeclaration,
} from "./tool.ts";

const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;
/** `models.classify()` and `models.generateImages()` calls one script may have in flight; `Promise.all` over many items queues the rest. */
const MAX_CONCURRENT_MODEL_CALLS = 4;
const MODEL_TYPES: ReadonlySet<string> = new Set<ModelType>(["chat", "image", "classifier"]);

function truncateText(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

function previewArgs(args: unknown): string {
	if (args === undefined) return "";
	try {
		return truncateText(JSON.stringify(args) ?? "", ARGS_PREVIEW_CHARS);
	} catch {
		return "";
	}
}

function textOf(result: AgentToolResult<unknown>): string {
	return (result.content ?? [])
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function toModelType(value: unknown): ModelType {
	if (typeof value === "string" && MODEL_TYPES.has(value)) return value as ModelType;
	throw new Error(`Unknown model type ${JSON.stringify(value)}. Use "chat", "image", or "classifier".`);
}

function toProvider(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error("provider must be a string");
	return value;
}

/** Catalog entry for scripts. `headers` is dropped because models.json headers can carry credentials. */
function toModelInfo(model: AnyModel): Record<string, unknown> {
	const info: Record<string, unknown> = { ...model };
	delete info.headers;
	return info;
}

/** `an image`, `a classifier`. */
function withArticle(word: string): string {
	return `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A script value in an error message: `undefined`, `a string`, `an array`, or its keys (`{ prompt }`). */
function describeValue(value: unknown): string {
	if (value === undefined || value === null) return String(value);
	if (Array.isArray(value)) return value.length === 0 ? "an empty array" : "an array";
	if (typeof value === "object") {
		const keys = Object.keys(value);
		if (keys.length === 0) return "{}";
		return `{ ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", ..." : ""} }`;
	}
	return typeof value === "string" ? "a string" : `a ${typeof value}`;
}

const CLASSIFIER_CONTEXT_SHAPE =
	'{ state: { ... }, questions: { <id>: { type: "choice", instructions, criteria: { <label>: <meaning> } } | { type: "score", instructions, criteria: [<lowest level>, ..., <highest level>] } | { type: "bool", instructions, criteria: { true: <meaning>, false: <meaning> } } } }';

/** Check a script's classifier context, so mistakes fail with the expected shape instead of a provider error. */
function checkClassifierContext(context: unknown): ClassifierContext {
	const fail = (problem: string) =>
		new Error(
			`models.classify() ${problem}. Expected context: ${CLASSIFIER_CONTEXT_SHAPE}. See "Classify" in ${CODEMODE_DOCS_PATH}.`,
		);
	if (!isRecord(context)) throw fail(`expects a context object as its second argument, got ${describeValue(context)}`);
	if (!isRecord(context.state)) throw fail(`context.state must be an object, got ${describeValue(context.state)}`);
	const { questions } = context;
	if (!isRecord(questions) || Object.keys(questions).length === 0) {
		throw fail(`context.questions must map question IDs to questions, got ${describeValue(questions)}`);
	}
	const isStrings = (values: unknown[]) => values.length > 0 && values.every((value) => typeof value === "string");
	for (const [id, question] of Object.entries(questions)) {
		const at = `context.questions.${id}`;
		if (!isRecord(question)) throw fail(`${at} must be a question object, got ${describeValue(question)}`);
		if (typeof question.instructions !== "string") throw fail(`${at}.instructions must be a string`);
		const { criteria } = question;
		if (question.type === "choice") {
			if (!isRecord(criteria) || !isStrings(Object.values(criteria))) {
				throw fail(`${at} is a "choice" question, so criteria must map each label to its meaning`);
			}
		} else if (question.type === "score") {
			if (!Array.isArray(criteria) || !isStrings(criteria)) {
				throw fail(`${at} is a "score" question, so criteria must list the levels as strings, lowest first`);
			}
		} else if (question.type === "bool") {
			if (!isRecord(criteria) || typeof criteria.true !== "string" || typeof criteria.false !== "string") {
				throw fail(`${at} is a "bool" question, so criteria must be { true: string, false: string }`);
			}
		} else {
			throw fail(`${at}.type must be "choice", "score", or "bool", got ${JSON.stringify(question.type)}`);
		}
	}
	return context as unknown as ClassifierContext;
}

/** Check a script's image context, so mistakes such as `{ prompt }` fail with the expected shape. */
function checkImagesContext(context: unknown): ImagesContext {
	const fail = (problem: string) =>
		new Error(
			`models.generateImages() ${problem}. Expected context: { input: [{ type: "text", text: <prompt> }, ...optional { type: "image", data: <base64>, mimeType } references] }. See "Generate images" in ${CODEMODE_DOCS_PATH}.`,
		);
	if (!isRecord(context)) throw fail(`expects a context object as its second argument, got ${describeValue(context)}`);
	const { input } = context;
	if (!Array.isArray(input) || input.length === 0) {
		throw fail(`context.input must be a non-empty array of blocks, got ${describeValue(input)}`);
	}
	input.forEach((block: unknown, index) => {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") return;
		if (
			isRecord(block) &&
			block.type === "image" &&
			typeof block.data === "string" &&
			typeof block.mimeType === "string"
		) {
			return;
		}
		throw fail(`context.input[${index}] must be a text or image block, got ${describeValue(block)}`);
	});
	return context as unknown as ImagesContext;
}

/** The fields of `ClassifierResult` and `AssistantImages` that a nested call row reports. */
interface ModelCallResult {
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;
	usage?: Usage;
}

/** Runs at most `limit` calls at once, in call order. */
function createLimiter(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async (run) => {
		if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
		active++;
		try {
			return await run();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

function isStoreEntryData(data: unknown): data is CodemodeStoreEntryData {
	if (typeof data !== "object" || data === null) return false;
	const { set, delete: deleted } = data as Partial<CodemodeStoreEntryData>;
	return (
		(data as Partial<CodemodeStoreEntryData>).version === 1 &&
		(data as Partial<CodemodeStoreEntryData>).encoding === "pickle-base64" &&
		typeof set === "object" &&
		set !== null &&
		!Array.isArray(set) &&
		Object.values(set).every((value) => typeof value === "string" && Buffer.from(value, "base64").toString("base64") === value) &&
		Array.isArray(deleted) &&
		deleted.every((key: unknown) => typeof key === "string")
	);
}

/** Values of `load()`: the `codemode-store` entries on the branch, applied from the root. */
export function readCodemodeStore(branch: readonly SessionEntry[]): Record<string, Uint8Array> {
	const store = new Map<string, Uint8Array>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== CODEMODE_STORE_ENTRY_TYPE || !isStoreEntryData(entry.data)) {
			continue;
		}
		for (const key of entry.data.delete) store.delete(key);
		for (const [key, value] of Object.entries(entry.data.set)) store.set(key, Buffer.from(value, "base64"));
	}
	return Object.fromEntries(store);
}

/** Default token budget for script output. */
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
/** Characters per token when estimating. */
const CHARS_PER_TOKEN = 4;

/** Like the script's `text()`: strings as is, other values as compact JSON. */
function valueText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value) ?? String(value);
}

/** Keep failure output separate without duplicating image payloads or unbounded text in details. */
function failureOutput(items: (TextContent | ImageContent)[], maxTokens: number): { type: "text" | "image"; text?: string }[] {
	const text = items.filter((item): item is TextContent => item.type === "text").map((item) => item.text).join("\n");
	const budget = maxTokens * CHARS_PER_TOKEN;
	const head = Math.floor(budget / 2);
	const tail = budget - head;
	const preview = text.length <= budget ? text :
		`${text.slice(0, head)}\n… output truncated …\n${tail ? text.slice(-tail) : ""}`;
	return [
		...(preview ? [{ type: "text" as const, text: preview }] : []),
		...items.filter((item) => item.type === "image").map(() => ({ type: "image" as const })),
	];
}

function formatCallSummary(calls: readonly CodemodeNestedCall[]): string {
	if (calls.length === 0) return "No tool calls were made.";
	return `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
}

function formatError(result: Extract<CodemodeResult, { ok: false }>, calls: readonly CodemodeNestedCall[]): string {
	const { error } = result;
	const head =
		error.kind === "script"
			? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
			: error.kind === "timeout"
				? `Script timed out: ${error.message}`
				: error.kind === "aborted"
					? `Script aborted: ${error.message}`
					: `Python execution failed: ${error.message}`;
	return `${head}\n\n${formatCallSummary(calls)}`;
}

/** Write the full text output to a temp file, like bash does for truncated output. */
async function spillOutput(text: string): Promise<{ path: string } | { error: string }> {
	try {
		return { path: await writeOutputFile("pi-codemode", ".txt", text) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** File extensions of the image types accepted by the runtime. */
const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

/**
 * Save each image to a temp file and put a text item with its path before it. The model sees the
 * image and can retrieve its bytes later. Images shown more than once are saved once.
 */
async function saveImages(items: (TextContent | ImageContent)[]): Promise<(TextContent | ImageContent)[]> {
	const labels = new Map<string, Promise<string>>();
	const label = async ({ data, mimeType }: ImageContent): Promise<string> => {
		const bytes = Buffer.from(data, "base64");
		const kind = `${mimeType}, ${formatSize(bytes.length)}`;
		const extension = IMAGE_EXTENSIONS[mimeType];
		if (!extension) throw new Error(`No file extension for image type ${mimeType}`);
		// A failed write (disk full, unwritable temp dir) must not discard the result of a script whose
		// tool calls already ran, so it becomes part of the label.
		try {
			const path = await writeOutputFile("pi-codemode", extension, bytes);
			return `[Image saved to ${path} (${kind})]`;
		} catch (error) {
			return `[Image (${kind}) could not be saved: ${error instanceof Error ? error.message : String(error)}]`;
		}
	};
	const result = await Promise.all(
		items.map(async (item): Promise<(TextContent | ImageContent)[]> => {
			if (item.type !== "image") return [item];
			let pending = labels.get(item.data);
			if (!pending) {
				pending = label(item);
				labels.set(item.data, pending);
			}
			return [{ type: "text", text: await pending }, item];
		}),
	);
	return result.flat();
}

/**
 * Apply the token budget: when the combined text exceeds it, the text items become one
 * item that keeps the start and end of the text, and images follow it. The full text is written to
 * a temp file.
 */
async function truncateOutput(
	items: (TextContent | ImageContent)[],
	maxTokens: number,
): Promise<{ items: (TextContent | ImageContent)[]; fullOutputPath?: string }> {
	const texts = items.filter((item): item is TextContent => item.type === "text").map((item) => item.text);
	const combined = texts.join("\n");
	const budget = maxTokens * CHARS_PER_TOKEN;
	if (texts.length === 0 || combined.length <= budget) return { items };
	const headChars = Math.floor(budget / 2);
	const tailChars = budget - headChars;
	const removed = combined.length - headChars - tailChars;
	const head = combined.slice(0, headChars);
	const tail = tailChars > 0 ? combined.slice(-tailChars) : "";
	let text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\nTotal output lines: ${combined.split("\n").length}\n\n${head}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tail}`;
	const spilled = await spillOutput(combined);
	text +=
		"path" in spilled
			? `\n\n[Full output: ${spilled.path} (read with offset/limit)]`
			: `\n\n[Could not save the full output: ${spilled.error}]`;
	return {
		items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
		...("path" in spilled ? { fullOutputPath: spilled.path } : {}),
	};
}

/**
 * The value a script receives for a nested call: a tool that declares
 * `outputSchema` resolves to its `structuredContent`, also for error results that carry one (such
 * as MCP results with `isError`); any other tool resolves to its text content. Other failures
 * reject with the tool's error text.
 */
function toScriptValue(tool: AgentTool<any>, outcome: AgentToolCallOutcome): unknown {
	const { result } = outcome;
	if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
	const text = textOf(result);
	if (outcome.isError) throw new Error(text || `Tool "${tool.name}" failed`);
	return text;
}

/**
 * Run one script. Without a session context (a plain Agent or a direct call) scripts cannot call
 * tools, `store()` starts empty, and writes are dropped.
 */
export async function executeCodemode(
	toolCallId: string,
	input: CodemodeToolInput,
	signal: AbortSignal | undefined,
	onUpdate: ((result: AgentToolResult<CodemodeToolDetails>) => void) | undefined,
	ctx: ExtensionToolContext | undefined,
	options: CodemodeToolOptions = {},
): Promise<AgentToolResult<CodemodeToolDetails>> {
	const startedAt = performance.now();
	if (ctx && typeof ctx.executeTool !== "function") {
		throw new Error("Python codemode requires Pi's public ctx.executeTool nested-call pipeline; this Pi version does not provide it.");
	}
	const { code, options: sourceOptions } = parseCodemodeSource(input.code);
	const calls: CodemodeNestedCall[] = [];
	// Usage of the script's `models.*` calls. Nested tool calls report theirs through the session.
	let modelUsage: Usage | undefined;
	// Images returned by `models.generateImages()`, to notice a script that never shows them.
	let generatedImages = 0;
	const addGeneratedImages = (count: number) => {
		generatedImages += count;
	};
	const addModelUsage = (usage: Usage) => {
		modelUsage = modelUsage ? combineUsage(modelUsage, usage) : usage;
	};

	const snapshot = (): CodemodeToolDetails => ({ calls: calls.map((call) => ({ ...call })) });
	const publish = () => onUpdate?.({ content: [], details: snapshot() });

	const callable = ctx ? getCodemodeCallableTools(ctx.tools) : [];
	// ALL_TOOLS entries carry the declaration.
	const samples = new Map(callable.map((tool) => [tool.name, renderToolSample(toCodemodeDeclaration(tool))]));
	const runtimeTools: CodemodeTool[] = callable.map((tool) => ({
		name: tool.name,
		description: samples.get(tool.name),
		execute: async (args, { signal: callSignal }) => {
			const record: CodemodeNestedCall = {
				id: `${toolCallId}/?`,
				name: tool.name,
				args: previewArgs(args),
				status: "running",
			};
			calls.push(record);
			publish();
			const callStartedAt = performance.now();
			// Only tools from ctx.tools are callable, so ctx is set here.
			if (!ctx) throw new Error("Tool calls need a session");
			try {
				const outcome = await ctx.executeTool(tool.name, args, { signal: callSignal });
				record.id = outcome.toolCall.id;
				record.status = outcome.isError ? (callSignal.aborted ? "cancelled" : "error") : "ok";
				if (outcome.isError) record.error = truncateText(textOf(outcome.result) || `Tool "${tool.name}" failed`, ERROR_PREVIEW_CHARS);
				return toScriptValue(tool, outcome);
			} catch (error) {
				record.status = callSignal.aborted ? "cancelled" : "error";
				record.error = truncateText(error instanceof Error ? error.message : String(error), ERROR_PREVIEW_CHARS);
				throw error;
			} finally {
				record.durationMs = performance.now() - callStartedAt;
				publish();
			}
		},
	}));

	const environment = new CodemodeExecutionEnv({
		cwd: ctx?.cwd,
		tools: runtimeTools,
		globals: [
			...createDiscoveryGlobals(callable, samples, options),
			...(options.models && ctx
				? createModelGlobals(ctx.modelRegistry, toolCallId, calls, publish, addModelUsage, addGeneratedImages)
				: []),
		],
		timeoutMs: sourceOptions.timeoutMs ?? Number.POSITIVE_INFINITY,
	});

	let result: CodemodeResult;
	try {
		const store = ctx ? readCodemodeStore(ctx.sessionManager.getBranch()) : {};
		result = await environment.execute(code, { signal, store });
	} finally {
		await environment.close();
	}
	// Calls still marked running were cut off by the script ending, a timeout, or an abort.
	for (const call of calls) {
		if (call.status === "running") call.status = "cancelled";
	}

	const items: (TextContent | ImageContent)[] = result.output.map((item) =>
		item.type === "text" ? { type: "text", text: item.text } : item,
	);
	if (result.ok) {
		const { set, delete: deleted } = result.storeWrites;
		if (Object.keys(set).length > 0 || deleted.length > 0) {
			options.appendEntry?.(CODEMODE_STORE_ENTRY_TYPE, {
				version: 1,
				encoding: "pickle-base64",
				set: Object.fromEntries(Object.entries(set).map(([key, value]) => [key, Buffer.from(value).toString("base64")])),
				delete: deleted,
			});
		}
		// pi extension: a returned value is appended like text().
		if (result.value !== undefined) items.push({ type: "text", text: valueText(result.value) });
	}
	if (generatedImages > 0 && !items.some((item) => item.type === "image")) {
		items.push({
			type: "text",
			text: `Note: models.generateImages() returned ${generatedImages} image${generatedImages === 1 ? "" : "s"} that the script did not show. Show each image block of result.output with image(block).`,
		});
	}

	const maxOutputTokens = sourceOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
	const ordinaryOutput = !result.ok ? failureOutput(items, maxOutputTokens) : undefined;
	if (!result.ok) items.push({ type: "text", text: `Script error:\n${formatError(result, calls)}` });
	const truncated = await truncateOutput(items, maxOutputTokens);
	// After truncation, which joins the text items and moves images after them, so each path stays
	// next to its image and is never cut.
	const output = await saveImages(truncated.items);
	const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
	const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${wallTime} seconds\nOutput:\n`;
	const details = snapshot();
	if (!result.ok) details.failure = {
		error: result.error, durationMs: performance.now() - startedAt, output: ordinaryOutput!,
	};
	if (truncated.fullOutputPath) details.fullOutputPath = truncated.fullOutputPath;
	return {
		content: [{ type: "text", text: header }, ...output],
		details,
		...(modelUsage ? { usage: modelUsage } : {}),
		...(result.ok ? {} : { isError: true }),
	};
}

/**
 * Whether `query` names the namespace: its name, its script identifier (`mcp__dev-radius` is
 * `mcp__dev_radius`), or the part after its last `__` in either form (`dev-radius`, `dev_radius`).
 */
function isNamespaceName(namespace: string, query: string): boolean {
	const id = toCodemodeIdentifier(namespace);
	const queryId = toCodemodeIdentifier(query);
	const suffix = (name: string) => (name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : undefined);
	return namespace === query || id === queryId || suffix(namespace) === query || suffix(id) === queryId;
}

/**
 * `searchTools()`, `describeTool()`, and `describeNamespace()`: ranked search and lookup over the
 * script's nested tools and their namespaces.
 */
function createDiscoveryGlobals(
	tools: readonly AgentTool<any>[],
	samples: ReadonlyMap<string, string>,
	options: CodemodeToolOptions,
): CodemodeTool[] {
	const ranker = new Bm25Ranker();
	const entry = (name: string) => ({ name: toCodemodeIdentifier(name), description: samples.get(name) ?? "" });
	return [
		{
			name: "searchTools",
			spread: true,
			execute: (args) => {
				const [query, searchOptions] = args as [unknown, { limit?: unknown; namespace?: unknown } | undefined];
				if (typeof query !== "string") throw new Error("searchTools() expects a query string");
				const limit = searchOptions?.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
					throw new Error("searchTools() limit must be a positive integer");
				}
				const namespace = searchOptions?.namespace;
				if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
					throw new Error("searchTools() namespace must be a string");
				}
				const documents = tools.flatMap((tool) => {
					const toolNamespace = options.getToolNamespace?.(tool.name);
					if (namespace && (!toolNamespace || !isNamespaceName(toolNamespace.name, namespace))) return [];
					return [createToolSearchDocument(tool, toolNamespace)];
				});
				return ranker.rank(query, documents, limit).map((match) => entry(match.name));
			},
		},
		{
			name: "describeTool",
			spread: true,
			execute: (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
				const tool = tools.find(
					(candidate) => candidate.name === name || toCodemodeIdentifier(candidate.name) === name,
				);
				return tool ? samples.get(tool.name) : undefined;
			},
		},
		{
			name: "describeNamespace",
			spread: true,
			execute: (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeNamespace() expects a namespace name");
				let namespace: ToolNamespace | undefined;
				const names: string[] = [];
				for (const tool of tools) {
					const toolNamespace = options.getToolNamespace?.(tool.name);
					if (!toolNamespace || !isNamespaceName(toolNamespace.name, name)) continue;
					namespace ??= toolNamespace;
					names.push(toCodemodeIdentifier(tool.name));
				}
				if (!namespace) return undefined;
				return {
					name: namespace.name,
					...(namespace.description ? { description: namespace.description } : {}),
					...(namespace.instructions ? { instructions: namespace.instructions } : {}),
					tools: names,
				};
			},
		},
	];
}

/**
 * `models.*` for scripts: the model registry methods documented in docs/codemode.md.
 * Classifier and image calls appear as nested call rows so the renderer shows them, and their usage
 * goes to `addUsage`. Rows show only the model, never prompts or image data.
 */
function createModelGlobals(
	models: CodemodeModelRuntime,
	toolCallId: string,
	calls: CodemodeNestedCall[],
	publish: () => void,
	addUsage: (usage: Usage) => void,
	addGeneratedImages: (count: number) => void,
): CodemodeTool[] {
	const limit = createLimiter(MAX_CONCURRENT_MODEL_CALLS);
	let callCount = 0;

	/**
	 * Resolve the script's model by provider and id only, check the context, then run the call as a
	 * nested call row. A script-supplied baseUrl or headers must never receive the credentials.
	 */
	const runModelCall = async <TType extends "classifier" | "image", TContext, TResult extends ModelCallResult>(
		name: string,
		type: TType,
		[model, context]: unknown[],
		checkContext: (context: unknown) => TContext,
		signal: AbortSignal,
		run: (resolved: ModelTypeMap[TType], context: TContext) => Promise<TResult>,
	): Promise<TResult> => {
		const listHint = `List the ${type} models you can use with models.getAvailableOfType("${type}").`;
		if (!isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string") {
			// Missing model values arrive as null through JSON.
			const undefinedHint =
				model === undefined || model === null
					? " models.getModelOfType() returns undefined for an unknown provider or id."
					: "";
			throw new Error(
				`${name}() expects ${withArticle(type)} model as its first argument, got ${describeValue(model)}.${undefinedHint} ${listHint}`,
			);
		}
		const { provider, id } = model;
		const ref = `${provider}/${id}`;
		const resolved = models.getModelOfType(type, provider, id);
		if (!resolved) {
			const actualType = [...MODEL_TYPES].find(
				(other) => other !== type && models.getModelOfType(other as ModelType, provider, id) !== undefined,
			);
			throw new Error(
				actualType
					? `"${ref}" is ${withArticle(actualType)} model, not ${withArticle(type)} model. ${listHint}`
					: `Unknown ${type} model "${ref}". ${listHint}`,
			);
		}
		const checked = checkContext(context);

		const record: CodemodeNestedCall = {
			id: `${toolCallId}/${name}/${++callCount}`,
			name,
			args: `${resolved.provider}/${resolved.id}`,
			status: "running",
		};
		calls.push(record);
		publish();
		const startedAt = performance.now();
		try {
			const result = await limit(() => {
				// Cancellation may happen while this call waits for the shared four-call slot.
				signal.throwIfAborted();
				return run(resolved, checked);
			});
			record.status = result.stopReason === "stop" ? "ok" : result.stopReason === "aborted" ? "cancelled" : "error";
			if (result.errorMessage) record.error = truncateText(result.errorMessage, ERROR_PREVIEW_CHARS);
			if (result.usage) {
				record.cost = result.usage.cost.total;
				addUsage(result.usage);
			}
			return result;
		} catch (error) {
			record.status = signal.aborted ? "cancelled" : "error";
			record.error = truncateText(error instanceof Error ? error.message : String(error), ERROR_PREVIEW_CHARS);
			throw error;
		} finally {
			record.durationMs = performance.now() - startedAt;
			publish();
		}
	};
	const implementations: Record<string, CodemodeTool["execute"]> = {
		"models.getModelsOfType": (args) => {
			const [type, provider] = args as unknown[];
			return models.getModelsOfType(toModelType(type), toProvider(provider)).map(toModelInfo);
		},
		"models.getAvailableOfType": async (args, { signal }) => {
			const [type, provider] = args as unknown[];
			const available = await models.getAvailableOfType(toModelType(type), toProvider(provider), { signal });
			return available.map(toModelInfo);
		},
		"models.getModelOfType": (args) => {
			const [type, provider, id] = args as unknown[];
			if (typeof provider !== "string" || typeof id !== "string") {
				throw new Error(
					`models.getModelOfType(type, provider, id) expects three strings, got (${(args as unknown[]).map(describeValue).join(", ")}). The provider and the id are separate arguments, for example models.getModelOfType("classifier", "typesafe", "jev-latest").`,
				);
			}
			const model = models.getModelOfType(toModelType(type), provider, id);
			return model === undefined ? undefined : toModelInfo(model);
		},
		"models.classify": (args, { signal }) =>
			runModelCall("models.classify", "classifier", args as unknown[], checkClassifierContext, signal, (resolved, context) =>
				models.classify(resolved, context, { signal }),
			),
		"models.generateImages": (args, { signal }) =>
			runModelCall(
				"models.generateImages",
				"image",
				args as unknown[],
				checkImagesContext,
				signal,
				async (resolved, context) => {
					const result = await models.generateImages(resolved, context, { signal });
					addGeneratedImages(result.output.filter((block) => block.type === "image").length);
					return result;
				},
			),
	};
	return Object.entries(implementations).map(([name, execute]) => ({ name, spread: true, execute }));
}
