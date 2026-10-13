import { toCodemodeIdentifier, validateGlobalNames, validateToolNames } from "./identifier.ts";
import type { CodemodeJsonSchema, CodemodeTool } from "./types.ts";

export { toCodemodeIdentifier };

/** Largest rendered input schema, including its supporting definitions, before it becomes Any. */
export const DEFAULT_INPUT_SCHEMA_MAX_CHARS = 16_000;
const MAX_REF_EXPANSIONS = 32;
const MAX_DEPTH = 64;
/** Constraints Python annotations cannot express, rendered as property comment tags. */
const TAG_KEYWORDS = [
	"minimum", "exclusiveMinimum", "maximum", "exclusiveMaximum", "multipleOf",
	"minLength", "maxLength", "pattern", "format", "minItems", "maxItems",
];
const LOWER_BOUNDS = new Set(["minimum", "exclusiveMinimum", "minLength", "minItems"]);
const UPPER_BOUNDS = new Set(["maximum", "exclusiveMaximum", "maxLength", "maxItems"]);
const MAX_TAG_CHARS = 80;
const LINE_TERMINATORS = /[\r\n\u2028\u2029]/g;
const TYPING_NAMES = ["Any", "Awaitable", "Callable", "Literal", "Never", "NotRequired", "Required", "TypedDict"];
const BUILTIN_NAMES = ["str", "int", "float", "bool", "list", "dict"];
const EXACT_LOOKUP = '    def __getitem__(self, name: str) -> Callable[[Any], Awaitable[Any]]:\n        "Exact original-name lookup, including names that need attribute aliases."\n        ...';

export interface RenderDeclarationsOptions {
	tools?: readonly CodemodeTool[];
	globals?: readonly CodemodeTool[];
}

interface RenderState {
	definitions: string[];
	usedNames: Set<string>;
	next: number;
	inline: boolean;
	/** Alternate bindings for annotation names shadowed by globals or namespace members. */
	aliases: Map<string, string>;
}

function state(inline = false, names: string[] = []): RenderState {
	const render: RenderState = {
		definitions: [], next: 0, inline,
		usedNames: new Set([...TYPING_NAMES, ...BUILTIN_NAMES, "Tools", ...names]),
		aliases: new Map(),
	};
	for (const name of [...TYPING_NAMES, ...BUILTIN_NAMES]) {
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
	return [importSection, ...render.definitions.map((definition) => qualify(definition, render)), ...sections].join("\n\n");
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
	const output = renderSchema(tool.outputSchema, render, `${tool.name}_Result`);
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
	const output = renderSchema(tool.outputSchema, render, `${tool.name}_Result`);
	const declaration = moduleText(render, [`class Tools:\n    async def ${toCodemodeIdentifier(tool.name)}(self, args: ${input}) -> ${output}:\n        ...\n\n${qualify(EXACT_LOOKUP, render)}\n\ntools: Tools`]);
	return `${tool.description?.trim() ?? ""}\n\ncodemode tool declaration:\n\`\`\`python\n${declaration}\n\`\`\``;
}

/** Python annotation expression rendered directly from the output schema, or Any without one. */
export function renderToolOutputType(schema: CodemodeJsonSchema | undefined): string {
	return schema === undefined ? "Any" : schemaToType(schema);
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
		const output = renderSchema(tool.outputSchema, render, `${tool.name}_Result`);
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
	tags: boolean;
}

/**
 * Python annotation expression; object shapes use functional TypedDict expressions.
 * For named definitions suitable for type checkers, use renderDeclarations instead.
 * Recursive/remote refs and unrepresentable intersections use Any. Budgets include shape text.
 * Over-budget schemas render again without constraint tags before falling back to Any.
 */
export function schemaToType(schema: CodemodeJsonSchema, options: { maxChars?: number } = {}): string {
	return renderSchema(schema, state(true), "Schema", options.maxChars);
}

function renderSchema(schema: CodemodeJsonSchema | undefined, render: RenderState, hint: string, maxChars?: number): string {
	if (schema === undefined) return qualify("Any", render);
	const before = render.definitions.length;
	const names = new Set(render.usedNames);
	const next = render.next;
	const reset = () => {
		render.definitions.length = before;
		render.usedNames = new Set(names);
		render.next = next;
	};
	for (const tags of [true, false]) {
		const type = toType(schema, {
			root: schema, resolving: new Set(), budget: { expansions: 0 }, depth: 0, render, tags,
		}, hint);
		const size = type.length + render.definitions.slice(before).join("\n\n").length;
		if (maxChars === undefined || size <= maxChars) return qualify(type, render);
		reset();
	}
	return qualify("Any", render);
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

/** Keep the upstream constraint extraction rules; Python int already expresses integer types. */
function constraintTags(schema: unknown): string {
	if (!isObject(schema)) return "";
	const property = schema;
	const variants = Array.isArray(property.anyOf) ? property.anyOf : property.oneOf;
	const nonNull = Array.isArray(variants) ? variants.filter((variant) => variant?.type !== "null") : [];
	const branch = nonNull.length === 1 ? nonNull[0] : undefined;
	const branches = isObject(branch) ? [property, branch] : [property];
	// Draft-04 and OpenAPI 3.0 express exclusivity with boolean keywords.
	const schemas = branches.map((schema): Record<string, unknown> => ({
		...schema,
		...(schema.exclusiveMinimum === true ? { minimum: undefined, exclusiveMinimum: schema.minimum } : {}),
		...(schema.exclusiveMaximum === true ? { maximum: undefined, exclusiveMaximum: schema.maximum } : {}),
	}));
	const tags: string[] = [];
	for (const keyword of TAG_KEYWORDS) {
		const values = schemas.map((schema) => schema[keyword]);
		if (LOWER_BOUNDS.has(keyword) || UPPER_BOUNDS.has(keyword)) {
			const numbers = values.filter((value): value is number => typeof value === "number");
			if (numbers.length === 0) continue;
			tags.push(`@${keyword} ${LOWER_BOUNDS.has(keyword) ? Math.max(...numbers) : Math.min(...numbers)}`);
			continue;
		}
		for (const value of new Set(values)) {
			if (typeof value === "number" || typeof value === "string") tags.push(`@${keyword} ${value}`);
		}
	}
	if (schemas.some((schema) => schema.uniqueItems === true)) tags.push("@uniqueItems");
	// Annotations, unlike constraints, come from the property itself.
	if (property.default !== undefined && property.default !== null) tags.push(`@default ${JSON.stringify(property.default)}`);
	if (property.deprecated === true) tags.push("@deprecated");
	return tags.filter((tag) => tag.length <= MAX_TAG_CHARS)
		.map((tag) => tag.replace(LINE_TERMINATORS, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`))
		.join(" ");
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
	const comments = names.map((name) => {
		const lines: string[] = [];
		const property = properties[name];
		if (isObject(property) && typeof property.description === "string") {
			for (const line of property.description.trim().split(LINE_TERMINATORS)) {
				lines.push(`# ${JSON.stringify(name)}: ${line.replaceAll("\0", "\\0")}`);
			}
		}
		const tags = context.tags ? constraintTags(property) : "";
		if (tags) lines.push(`# ${JSON.stringify(name)}: ${tags}`);
		return lines;
	});
	const descriptionLines = comments.flat();
	if (schema.additionalProperties !== false) descriptionLines.push("# Additional JSON keys may be present; Python 3.12 TypedDict cannot type extra keys.");
	const expression = `TypedDict(${JSON.stringify(typeName)}, {${fields.join(", ")}}, total=False)`;
	if (context.render.inline) {
		if (!comments.some((lines) => lines.length)) return expression;
		const members = fields.map((field, index) => [...comments[index], `${field},`]
			.map((line) => `    ${line.replaceAll("\n", "\n    ")}`).join("\n"));
		return `TypedDict(${JSON.stringify(typeName)}, {\n${members.join("\n")}\n}, total=False)`;
	}
	context.render.definitions.push([...descriptionLines, `${typeName} = ${expression}`].join("\n"));
	return typeName;
}
