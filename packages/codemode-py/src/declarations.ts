import { toCodemodeIdentifier, validateGlobalNames, validateToolNames } from "./identifier.ts";
import type { CodemodeJsonSchema, CodemodeTool } from "./types.ts";

export { toCodemodeIdentifier };

/** Largest rendered input schema, including its supporting definitions, before it becomes Any. */
export const DEFAULT_INPUT_SCHEMA_MAX_CHARS = 16_000;
const MAX_REF_EXPANSIONS = 32;
const MAX_DEPTH = 64;
const TYPING_NAMES = ["Any", "Awaitable", "Callable", "Literal", "Never", "NotRequired", "Required", "TypedDict"];
const BUILTIN_NAMES = ["str", "int", "float", "bool", "list", "dict"];
const MCP_NAMES = ["Role", "MetaObject", "Annotations", "Icon", "TextResourceContents", "BlobResourceContents",
	"TextContent", "ImageContent", "AudioContent", "ResourceLink", "EmbeddedResource", "ContentBlock", "CallToolResult"];
const IMPORTS = `from __future__ import annotations\nfrom typing import ${TYPING_NAMES.join(", ")}`;
const EXACT_LOOKUP = '    def __getitem__(self, name: str) -> Callable[[Any], Awaitable[Any]]:\n        "Exact original-name lookup, including names that need attribute aliases."\n        ...';

/** Python 3.12 MCP result types. Functional TypedDict preserves JSON keys without aliasing them. */
export const MCP_PYTHON_PREAMBLE = `${IMPORTS}

Role = Literal["user", "assistant"]
MetaObject = dict[str, Any]
Annotations = TypedDict("Annotations", {"audience": list[Role], "priority": float, "lastModified": str}, total=False)
Icon = TypedDict("Icon", {"src": Required[str], "mimeType": str, "sizes": list[str], "theme": Literal["light", "dark"]}, total=False)
TextResourceContents = TypedDict("TextResourceContents", {"uri": Required[str], "mimeType": str, "_meta": MetaObject, "text": Required[str]}, total=False)
BlobResourceContents = TypedDict("BlobResourceContents", {"uri": Required[str], "mimeType": str, "_meta": MetaObject, "blob": Required[str]}, total=False)
TextContent = TypedDict("TextContent", {"type": Required[Literal["text"]], "text": Required[str], "annotations": Annotations, "_meta": MetaObject}, total=False)
ImageContent = TypedDict("ImageContent", {"type": Required[Literal["image"]], "data": Required[str], "mimeType": Required[str], "annotations": Annotations, "_meta": MetaObject}, total=False)
AudioContent = TypedDict("AudioContent", {"type": Required[Literal["audio"]], "data": Required[str], "mimeType": Required[str], "annotations": Annotations, "_meta": MetaObject}, total=False)
ResourceLink = TypedDict("ResourceLink", {"type": Required[Literal["resource_link"]], "name": Required[str], "uri": Required[str], "icons": list[Icon], "title": str, "description": str, "mimeType": str, "annotations": Annotations, "size": int, "_meta": MetaObject}, total=False)
EmbeddedResource = TypedDict("EmbeddedResource", {"type": Required[Literal["resource"]], "resource": Required[TextResourceContents | BlobResourceContents], "annotations": Annotations, "_meta": MetaObject}, total=False)
ContentBlock = TextContent | ImageContent | AudioContent | ResourceLink | EmbeddedResource

class CallToolResult[TStructured](TypedDict):
    content: list[ContentBlock]
    isError: NotRequired[bool]
    structuredContent: NotRequired[TStructured]
    _meta: NotRequired[MetaObject]`;

export interface RenderDeclarationsOptions {
	tools?: readonly CodemodeTool[];
	globals?: readonly CodemodeTool[];
}

interface RenderState {
	definitions: string[];
	usedNames: Set<string>;
	next: number;
	mcp: boolean;
	inline: boolean;
	/** Alternate bindings for annotation names shadowed by globals or namespace members. */
	aliases: Map<string, string>;
}

function state(inline = false, names: string[] = []): RenderState {
	const render: RenderState = {
		definitions: [], next: 0, mcp: false, inline,
		usedNames: new Set([...TYPING_NAMES, ...BUILTIN_NAMES, ...MCP_NAMES, "Tools", ...names]),
		aliases: new Map(),
	};
	for (const name of [...TYPING_NAMES, ...BUILTIN_NAMES, ...MCP_NAMES]) {
		if (names.includes(name)) render.aliases.set(name, newName(render, name));
	}
	return render;
}

function newName(render: RenderState, hint: string): string {
	const base = `Codemode_${toCodemodeIdentifier(hint)}`;
	let name = base;
	while (render.usedNames.has(name)) name = `${base}_${++render.next}`;
	render.usedNames.add(name);
	return name;
}

function moduleText(render: RenderState, sections: string[]): string {
	const imports = `from __future__ import annotations\nfrom typing import ${TYPING_NAMES.map((name) => binding(render, name)).join(", ")}`;
	const builtins = BUILTIN_NAMES.filter((name) => render.aliases.has(name));
	const importSection = imports + (builtins.length ? `\nfrom builtins import ${builtins.map((name) => binding(render, name)).join(", ")}` : "");
	let preamble = "";
	if (render.mcp) {
		preamble = qualify(MCP_PYTHON_PREAMBLE.slice(IMPORTS.length), render);
		// Functional TypedDict names must agree with their assigned aliases for type checkers.
		for (const name of MCP_NAMES) {
			const alias = render.aliases.get(name);
			if (alias) preamble = preamble.replaceAll(`("${name}",`, `("${alias}",`);
		}
	}
	return [importSection + preamble, ...render.definitions.map((definition) => qualify(definition, render)), ...sections].join("\n\n");
}

function binding(render: RenderState, name: string): string {
	const alias = render.aliases.get(name);
	return alias ? `${name} as ${alias}` : name;
}

/** Rewrite annotation identifiers only, never JSON keys, Literal strings or descriptions. */
function qualify(source: string, render: RenderState): string {
	return source.replace(/#[^\r\n]*|"""(?:\\[\s\S]|(?!""")[\s\S])*"""|'''(?:\\[\s\S]|(?!''')[\s\S])*'''|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[A-Za-z_][A-Za-z0-9_]*/g,
		(token) => render.aliases.get(token) ?? token);
}

/** Locate punctuation outside strings and nested bracket expressions. */
function topLevelPositions(source: string, punctuation: string): number[] {
	const positions: number[] = [];
	let depth = 0;
	const tokens = source.matchAll(/"""(?:\\[\s\S]|(?!""")[\s\S])*"""|'''(?:\\[\s\S]|(?!''')[\s\S])*'''|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[\s\S]/g);
	for (const match of tokens) {
		const token = match[0];
		if (token.length !== 1 || token === "'" || token === '"') continue;
		if (depth === 0 && punctuation.includes(token)) positions.push(match.index!);
		if ("([{".includes(token)) depth++;
		if (")]}".includes(token)) depth--;
	}
	return positions;
}

function qualifySignature(signature: string, render: RenderState): string {
	// The closing parameter parenthesis is followed by the documented " -> " separator.
	const separator = topLevelPositions(signature, "-").find((index) => signature.slice(index, index + 2) === "->");
	if (separator === undefined) return signature;
	const head = signature.slice(0, separator).trimEnd();
	const parameters = head.slice(1, -1);
	const boundaries = [-1, ...topLevelPositions(parameters, ","), parameters.length];
	const rewritten = boundaries.slice(0, -1).map((start, index) => {
		const parameter = parameters.slice(start + 1, boundaries[index + 1]);
		const colon = topLevelPositions(parameter, ":")[0];
		if (colon === undefined) return parameter;
		const equals = topLevelPositions(parameter, "=").find((position) => position > colon) ?? parameter.length;
		return parameter.slice(0, colon + 1) + qualify(parameter.slice(colon + 1, equals), render) + parameter.slice(equals);
	}).join(",");
	return `(${rewritten}) -> ${qualify(signature.slice(separator + 2).trimStart(), render)}`;
}

/** Render a self-contained Python stub module, with named TypedDict shapes and async functions. */
export function renderDeclarations(options: RenderDeclarationsOptions): string {
	const tools = options.tools ?? [];
	const globals = options.globals ?? [];
	validateToolNames(tools);
	validateGlobalNames(globals);
	const render = state(false, [
		...globals.flatMap((global) => global.name.split(".")), ...tools.map((tool) => toCodemodeIdentifier(tool.name)),
	]);
	const sections: string[] = [];
	if (tools.length > 0) {
		const members = tools.map((tool) => functionStub(tool, render, "    ", true));
		const toolsType = globals.some((global) => global.name.split(".")[0] === "Tools") ? newName(render, "Tools") : "Tools";
		sections.push(`class ${toolsType}:\n${members.join("\n\n")}\n\n${qualify(EXACT_LOOKUP, render)}\n\ntools: ${toolsType}`);
	}
	const namespaces = new Map<string, CodemodeTool[]>();
	for (const global of globals) {
		if (!global.name.includes(".")) sections.push(functionStub(global, render, "", false, true));
		else {
			const namespace = global.name.split(".")[0];
			if (!namespaces.has(namespace)) namespaces.set(namespace, []);
			namespaces.get(namespace)!.push(global);
		}
	}
	for (const [namespace, members] of namespaces) {
		const name = newName(render, `${namespace}_Namespace`);
		sections.push(`class ${name}:\n${members.map((global) => functionStub(global, render, "    ", true, true)).join("\n\n")}\n\n${namespace}: ${name}`);
	}
	return moduleText(render, sections);
}

/** One callable as a self-contained Python stub, including imports and supporting types. */
export function renderToolSignature(
	tool: Pick<CodemodeTool, "name" | "inputSchema" | "outputSchema">,
	options: { inputMaxChars?: number } = {},
): string {
	validateToolNames([tool]);
	const render = state(false, [toCodemodeIdentifier(tool.name)]);
	const input = renderSchema(tool.inputSchema, render, `${tool.name}_Args`, options.inputMaxChars ?? DEFAULT_INPUT_SCHEMA_MAX_CHARS);
	const output = outputType(tool.outputSchema, render, `${tool.name}_Result`);
	return moduleText(render, [`async def ${toCodemodeIdentifier(tool.name)}(args: ${input}) -> ${output}:\n    ...`]);
}

/** Description followed by an executable-syntax Python declaration of tools.<alias>. */
export function renderToolSample(
	tool: Pick<CodemodeTool, "name" | "description" | "inputSchema" | "outputSchema">,
	options: { inputMaxChars?: number } = {},
): string {
	validateToolNames([tool]);
	const render = state(false, [toCodemodeIdentifier(tool.name)]);
	const input = renderSchema(tool.inputSchema, render, `${tool.name}_Args`, options.inputMaxChars ?? DEFAULT_INPUT_SCHEMA_MAX_CHARS);
	const output = outputType(tool.outputSchema, render, `${tool.name}_Result`);
	const declaration = moduleText(render, [`class Tools:\n    async def ${toCodemodeIdentifier(tool.name)}(self, args: ${input}) -> ${output}:\n        ...\n\n${qualify(EXACT_LOOKUP, render)}\n\ntools: Tools`]);
	return `${tool.description?.trim() ?? ""}\n\ncodemode tool declaration:\n\`\`\`python\n${declaration}\n\`\`\``;
}

/** Detect the structured content of an MCP CallToolResult, preserving the upstream heuristic. */
export function mcpStructuredContentSchema(schema: CodemodeJsonSchema | undefined): CodemodeJsonSchema | undefined {
	if (!isObject(schema) || !isObject(schema.properties)) return undefined;
	const { content, isError, _meta, structuredContent } = schema.properties;
	if (!isObject(content) || content.type !== "array" || !isObject(content.items) || content.items.type !== "object") return undefined;
	if (!isObject(isError) || isError.type !== "boolean" || !isObject(_meta) || _meta.type !== "object") return undefined;
	return isObject(structuredContent) || typeof structuredContent === "boolean" ? structuredContent : true;
}

function outputType(schema: CodemodeJsonSchema | undefined, render: RenderState, hint: string): string {
	const structured = mcpStructuredContentSchema(schema);
	if (structured !== undefined) {
		render.mcp = true;
		// A nested structured schema is its own reference root, matching upstream behavior.
		return `${qualify("CallToolResult", render)}[${renderSchema(structured, render, hint)}]`;
	}
	return renderSchema(schema, render, hint);
}

/** Python annotation expression. MCP annotations require MCP_PYTHON_PREAMBLE in their scope. */
export function renderToolOutputType(schema: CodemodeJsonSchema | undefined): string {
	return outputType(schema, state(true), "Result");
}

function functionStub(tool: CodemodeTool, render: RenderState, indent = "", method = false, global = false): string {
	const name = global ? tool.name.split(".").at(-1)! : toCodemodeIdentifier(tool.name);
	let signature: string;
	if (global && tool.signature !== undefined) {
		// Overrides use Python "(parameters) -> ReturnType", without async def or a trailing colon.
		signature = tool.signature.trim();
		if (!signature.startsWith("(") || !signature.includes(") -> ") || signature.endsWith(":")) {
			throw new Error(`Global "${tool.name}" signature must be Python "(parameters) -> ReturnType"`);
		}
		signature = qualifySignature(signature, render);
		if (method) signature = signature.replace(/^\(/, "(self, ").replace("(self, )", "(self)");
	} else {
		const input = renderSchema(tool.inputSchema, render, `${tool.name}_Args`, DEFAULT_INPUT_SCHEMA_MAX_CHARS);
		const output = outputType(tool.outputSchema, render, `${tool.name}_Result`);
		signature = `(${method ? "self, " : ""}${global && tool.spread ? `*args: ${qualify("Any", render)}` : `args: ${input}`}) -> ${output}`;
	}
	const description = tool.description?.trim();
	// A string expression acts as a docstring, escaping quotes, backslashes and newlines safely.
	return `${indent}async def ${name}${signature}:\n${description ? `${indent}    ${JSON.stringify(description)}\n` : ""}${indent}    ...`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function union(types: string[]): string {
	const unique = [...new Set(types)];
	if (unique.includes("Any")) return "Any";
	const real = unique.filter((type) => type !== "Never");
	return real.length === 0 ? "Never" : real.join(" | ");
}

interface SchemaContext {
	root: CodemodeJsonSchema;
	resolving: Set<string>;
	budget: { expansions: number };
	depth: number;
	render: RenderState;
}

/**
 * Python annotation expression; object shapes use functional TypedDict expressions.
 * For named definitions suitable for type checkers, use renderDeclarations instead.
 * Recursive/remote refs and unrepresentable intersections use Any. Budgets include shape text.
 */
export function schemaToType(schema: CodemodeJsonSchema, options: { maxChars?: number } = {}): string {
	return renderSchema(schema, state(true), "Schema", options.maxChars);
}

function renderSchema(schema: CodemodeJsonSchema | undefined, render: RenderState, hint: string, maxChars?: number): string {
	if (schema === undefined) return qualify("Any", render);
	const before = render.definitions.length;
	const names = new Set(render.usedNames);
	const type = toType(schema, { root: schema, resolving: new Set(), budget: { expansions: 0 }, depth: 0, render }, hint);
	const size = type.length + render.definitions.slice(before).join("\n\n").length;
	if (maxChars !== undefined && size > maxChars) {
		render.definitions.length = before;
		render.usedNames = names;
		return qualify("Any", render);
	}
	return qualify(type, render);
}

function resolveRef(ref: string, root: CodemodeJsonSchema): CodemodeJsonSchema | undefined {
	if (ref === "#") return root;
	if (!ref.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const segment of ref.slice(2).split("/")) {
		let key: string;
		try { key = decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~"); }
		catch { return undefined; }
		if (!isObject(current) || !Object.hasOwn(current, key)) return undefined;
		current = current[key];
	}
	return typeof current === "boolean" || isObject(current) ? current : undefined;
}

function literal(value: unknown): string {
	if (value === null) return "None";
	if (typeof value === "boolean") return `Literal[${value ? "True" : "False"}]`;
	if (typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))) return `Literal[${JSON.stringify(value)}]`;
	// Literal only accepts strings, integers, booleans and None, not floats or containers.
	if (typeof value === "number") return "float";
	return "Any";
}

function toType(schema: CodemodeJsonSchema, context: SchemaContext, hint: string): string {
	if (schema === false) return "Never";
	if (schema === true || !isObject(schema) || context.depth >= MAX_DEPTH) return "Any";
	context = { ...context, depth: context.depth + 1 };
	if (typeof schema.$ref === "string") {
		const ref = schema.$ref;
		if (context.resolving.has(ref) || context.budget.expansions >= MAX_REF_EXPANSIONS) return "Any";
		const target = resolveRef(ref, context.root);
		if (target === undefined) return "Any";
		context.budget.expansions++;
		context.resolving.add(ref);
		try { return toType(target, context, hint); }
		finally { context.resolving.delete(ref); }
	}
	if ("const" in schema) return literal(schema.const);
	if (Array.isArray(schema.enum)) return union(schema.enum.map(literal));
	const variants = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
	if (variants) return union(variants.map((variant, index) => toType(variant as CodemodeJsonSchema, context, `${hint}_${index}`)));
	// Python has no intersection type. Do not lie by turning allOf into a union.
	if (Array.isArray(schema.allOf)) {
		if (schema.allOf.length === 1) return toType(schema.allOf[0] as CodemodeJsonSchema, context, hint);
		return "Any";
	}
	if (Array.isArray(schema.type)) return union(schema.type.map((type) => toType({ ...schema, type }, context, hint)));
	switch (schema.type) {
		case "string": return "str";
		case "integer": return "int";
		case "number": return "int | float";
		case "boolean": return "bool";
		case "null": return "None";
		case "array": return arrayType(schema, context, hint);
		case "object": return objectType(schema, context, hint);
		case undefined:
			if ("properties" in schema || "additionalProperties" in schema || "required" in schema) return objectType(schema, context, hint);
			if ("items" in schema || "prefixItems" in schema) return arrayType(schema, context, hint);
			return "Any";
		default: return "Any";
	}
}

function arrayType(schema: Record<string, unknown>, context: SchemaContext, hint: string): string {
	const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : [];
	const types = prefix.map((item, index) => toType(item as CodemodeJsonSchema, context, `${hint}_Item${index}`));
	if (schema.items !== undefined && !Array.isArray(schema.items)) types.push(toType(schema.items as CodemodeJsonSchema, context, `${hint}_Item`));
	else if (prefix.length === 0 || !Array.isArray(schema.items) || schema.additionalItems !== false) types.push("Any");
	// JSON arrays arrive as Python lists, never tuples; prefixItems cannot assert tuple semantics.
	return `list[${union(types)}]`;
}

function objectType(schema: Record<string, unknown>, context: SchemaContext, hint: string): string {
	const properties = isObject(schema.properties) ? schema.properties : {};
	const names = Object.keys(properties).sort();
	if (names.length === 0) {
		const additional = schema.additionalProperties;
		const value = additional === false ? "Never" : additional === undefined || additional === true ? "Any"
			: toType(additional as CodemodeJsonSchema, context, `${hint}_Value`);
		return `dict[str, ${value}]`;
	}
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	const fields = names.map((name) => {
		const type = toType(properties[name] as CodemodeJsonSchema, context, `${hint}_${name}`);
		return `${JSON.stringify(name)}: ${required.has(name) ? "Required" : "NotRequired"}[${type}]`;
	});
	const typeName = context.render.inline ? "Schema" : newName(context.render, hint);
	const descriptionLines: string[] = [];
	for (const name of names) {
		const property = properties[name];
		if (isObject(property) && typeof property.description === "string") {
			for (const line of property.description.trim().split(/\r\n?|\n/)) {
				descriptionLines.push(`# ${JSON.stringify(name)}: ${line.replaceAll("\0", "\\0")}`);
			}
		}
	}
	if (schema.additionalProperties !== false) descriptionLines.push("# Additional JSON keys may be present; Python 3.12 TypedDict cannot type extra keys.");
	const expression = `TypedDict(${JSON.stringify(typeName)}, {${fields.join(", ")}}, total=False)`;
	if (context.render.inline) return expression;
	context.render.definitions.push([...descriptionLines, `${typeName} = ${expression}`].join("\n"));
	return typeName;
}
