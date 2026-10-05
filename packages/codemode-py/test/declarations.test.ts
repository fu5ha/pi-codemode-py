import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	MCP_PYTHON_PREAMBLE,
	mcpStructuredContentSchema,
	renderDeclarations,
	renderToolOutputType,
	renderToolSample,
	renderToolSignature,
	schemaToType,
} from "../src/index.ts";

const execute = () => undefined;
function mcpResultSchema(structuredContent?: unknown) {
	return {
		type: "object",
		properties: {
			content: { type: "array", items: { type: "object" } },
			...(structuredContent === undefined ? {} : { structuredContent }),
			isError: { type: "boolean" }, _meta: { type: "object" },
		},
		required: ["content"],
	};
}

describe("schemaToType", () => {
	it("renders primitives, literals, and unions", () => {
		expect(schemaToType({ type: "string" })).toBe("str");
		expect(schemaToType({ type: "integer" })).toBe("int");
		expect(schemaToType({ type: ["string", "null"] })).toBe("str | None");
		expect(schemaToType({ const: "a" })).toBe('Literal["a"]');
		expect(schemaToType({ enum: ["a", 1, null, true] })).toBe('Literal["a"] | Literal[1] | None | Literal[True]');
		expect(schemaToType({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("str | int | float");
		expect(schemaToType({ anyOf: [{ type: "string" }, {}] })).toBe("Any");
		expect(schemaToType({ allOf: [{ type: "string" }, { const: "a" }] })).toBe("Any");
		expect(schemaToType({ $ref: "#/defs/x" })).toBe("Any");
		expect(schemaToType(true)).toBe("Any");
		expect(schemaToType(false)).toBe("Never");
	});

	it("renders sorted JSON keys and required fields without aliasing object properties", () => {
		expect(schemaToType({
			type: "object",
			properties: { city: { type: "string" }, "max-lines": { type: "number" } },
			required: ["city"], additionalProperties: false,
		})).toBe('TypedDict("Schema", {"city": Required[str], "max-lines": NotRequired[int | float]}, total=False)');
		expect(schemaToType({ type: "object", additionalProperties: { type: "number" } })).toBe("dict[str, int | float]");
		expect(schemaToType({ type: "object" })).toBe("dict[str, Any]");
		expect(schemaToType({ type: "object", properties: {}, additionalProperties: false })).toBe("dict[str, Never]");
	});

	it("puts nested property descriptions on comment lines", () => {
		const rendered = renderDeclarations({ tools: [{
			name: "weather",
			inputSchema: {
				type: "object", properties: {
					weather: {
						type: "array", description: "look up weather for a given list of locations",
						items: {
							type: "object", properties: {
								location: { type: "string", description: "Location" },
							}, required: ["location"],
						},
					},
				}, required: ["weather"],
			}, execute,
		}] });
		expect(rendered).toContain('# "weather": look up weather for a given list of locations');
		expect(rendered).toContain('# "location": Location');
		expect(rendered.indexOf("Codemode_weather_Args_weather_Item =")).toBeLessThan(rendered.indexOf("Codemode_weather_Args ="));
		expect(rendered).toContain("Required[list[Codemode_weather_Args_weather_Item]]");
	});

	it("resolves local references and stops at recursive ones", () => {
		const schema = {
			type: "object", properties: {
				item: { $ref: "#/$defs/Item" }, legacy: { $ref: "#/definitions/Legacy" },
				remote: { $ref: "https://example.com/schema.json" },
			}, required: ["item"],
			$defs: {
				Item: {
					type: "object", properties: { id: { type: "string" }, parent: { $ref: "#/$defs/Item" } },
					required: ["id"],
				},
			}, definitions: { Legacy: { enum: ["a", "b"] } },
		};
		expect(schemaToType(schema)).toBe(
			'TypedDict("Schema", {"item": Required[TypedDict("Schema", {"id": Required[str], "parent": NotRequired[Any]}, total=False)], "legacy": NotRequired[Literal["a"] | Literal["b"]], "remote": NotRequired[Any]}, total=False)',
		);
		expect(schemaToType({ $ref: "#" })).toBe("Any");
		expect(schemaToType({ $ref: "#/$defs/%broken" })).toBe("Any");
	});

	it("renders JSON arrays as lists, including prefix schemas", () => {
		expect(schemaToType({ type: "array", items: { type: "string" } })).toBe("list[str]");
		expect(schemaToType({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }], items: false })).toBe("list[str | int | float]");
		expect(schemaToType({ type: "array", prefixItems: [{ type: "string" }] })).toBe("list[Any]");
		expect(schemaToType({ type: "array" })).toBe("list[Any]");
	});

	it("renders types over the budget as Any without retaining discarded definitions", () => {
		const properties = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`field${i}`, { type: "string" }]));
		const schema = { type: "object", properties };
		expect(schemaToType(schema, { maxChars: 100 })).toBe("Any");
		expect(schemaToType(schema)).toContain('"field49": NotRequired[str]');
		const signature = renderToolSignature({ name: "large", inputSchema: schema }, { inputMaxChars: 100 });
		expect(signature).toContain("args: Any");
		expect(signature).not.toContain("field49");
	});
});

describe("tool declarations", () => {
	it("renders signatures with normalized identifiers and named shapes", () => {
		const rendered = renderToolSignature({
			name: "hidden-dynamic-tool",
			inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});
		expect(rendered).toContain('Codemode_hidden_dynamic_tool_Args = TypedDict("Codemode_hidden_dynamic_tool_Args", {"city": Required[str]}, total=False)');
		expect(rendered).toContain("async def hidden_dynamic_tool(args: Codemode_hidden_dynamic_tool_Args) -> Codemode_hidden_dynamic_tool_Result:");
		expect(renderToolSignature({ name: "free" })).toContain("async def free(args: Any) -> Any:");
	});

	it("renders MCP CallToolResult output schemas as CallToolResult[T]", () => {
		const rendered = renderToolSignature({
			name: "mcp__sample__search",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			outputSchema: mcpResultSchema({
				type: "object",
				properties: { results: { type: "array", items: { $ref: "#/definitions/Result~1item~0v1" } } },
				required: ["results"], additionalProperties: false,
				definitions: {
					"Result/item~v1": {
						type: "object", properties: { id: { type: "string" }, score: { type: "number" } },
						required: ["id", "score"], additionalProperties: false,
					},
				},
			}),
		});
		expect(rendered).toContain(MCP_PYTHON_PREAMBLE);
		expect(rendered).toContain('{"id": Required[str], "score": Required[int | float]}');
		expect(rendered).toContain("-> CallToolResult[Codemode_mcp__sample__search_Result]:");
		expect(renderToolOutputType(mcpResultSchema())).toBe("CallToolResult[Any]");
		expect(mcpStructuredContentSchema({ type: "object", properties: { content: { type: "array" } } })).toBeUndefined();
	});

	it("renders the per-tool sample", () => {
		const rendered = renderToolSample({ name: "foo", description: "bar", inputSchema: { type: "string" } });
		expect(rendered).toContain("bar\n\ncodemode tool declaration:\n```python\n");
		expect(rendered).toContain("class Tools:\n    async def foo(self, args: str) -> Any:\n        ...");
		expect(rendered).toContain("def __getitem__(self, name: str) -> Callable[[Any], Awaitable[Any]]:");
		expect(rendered).toContain("tools: Tools");
	});
});

describe("renderDeclarations", () => {
	it("renders tools and globals", () => {
		const rendered = renderDeclarations({
			tools: [
				{
					name: "read", description: "Read a file.\nSecond line.",
					inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					outputSchema: { type: "string" }, execute,
				}, { name: "remote-api", execute }, { name: "with.dot", execute },
			],
			globals: [{ name: "attach", description: "Attach it.", inputSchema: { type: "string" }, execute }],
		});
		expect(rendered).toContain('Codemode_read_Args = TypedDict("Codemode_read_Args", {"path": Required[str]}, total=False)');
		expect(rendered).toContain('    async def read(self, args: Codemode_read_Args) -> str:\n        "Read a file.\\nSecond line."');
		expect(rendered).toContain("async def remote_api(self, args: Any) -> Any:");
		expect(rendered).toContain("async def with_dot(self, args: Any) -> Any:");
		expect(rendered).toContain('async def attach(args: str) -> Any:\n    "Attach it."');
	});

	it("renders namespaced globals and explicit signatures", () => {
		const rendered = renderDeclarations({ globals: [
			{ name: "models.list", description: "List models.", signature: "(kind: str) -> list[str]", execute },
			{ name: "models.get", inputSchema: { type: "string" }, execute },
			{ name: "plain", signature: "() -> None", execute },
		] });
		expect(rendered).toContain("async def plain() -> None:");
		expect(rendered).toContain("class Codemode_models_Namespace:");
		expect(rendered).toContain('    async def list(self, kind: str) -> Codemode_list[str]:\n        "List models."');
		expect(rendered).toContain("    async def get(self, args: str) -> Any:");
		expect(rendered).toContain("models: Codemode_models_Namespace");
	});

	it("escapes descriptions as Python strings, not executable source", () => {
		const rendered = renderDeclarations({ tools: [{ name: "x", description: 'a """ b\\\nnext', execute }] });
		expect(rendered).toContain(JSON.stringify('a """ b\\\nnext'));
	});

	// Generated Python mixes named nested types, keyword aliases, docstrings and a 3.12
	// generic MCP TypedDict. String snapshots cannot catch invalid typing constructs.
	it("executes emitted stub modules and preserves nested schema budgets", () => {
		const rendered = renderDeclarations({
			tools: [
				{
					name: "class", description: 'Quotes """ and\nnewlines',
					inputSchema: {
						type: "object", properties: {
							"not-valid": { type: "array", items: { type: "object", properties: { for: { enum: [true, false, null] } } } },
							x: { $ref: "#/$defs/R" },
						},
						$defs: { R: { type: "object", properties: { recursive: { $ref: "#/$defs/R" } } } },
					},
					outputSchema: mcpResultSchema({ type: "object", properties: { class: { type: "integer" } } }),
					execute,
				},
				{ name: "a-b", inputSchema: { type: "object", properties: { x: { type: "string" } } }, execute },
			],
			globals: [
				{ name: "models.list", signature: "(kind: str, limit: int | None = None) -> list[dict[str, Any]]", execute },
				{ name: "spread", spread: true, execute },
			],
		});
		const checked = spawnSync("python3", ["-c", "import sys; exec(compile(sys.stdin.read(), 'declarations.py', 'exec'))"], { input: rendered, encoding: "utf8" });
		expect(checked.stderr).toBe("");
		expect(checked.status).toBe(0);
		// Globals and class members may legitimately use type names. Resolve hints,
		// not just syntax, to detect late shadowing of imported/builtin annotations.
		const shadowed = renderDeclarations({
			tools: [{ name: "list", inputSchema: { const: "Literal" }, outputSchema: { type: "array", items: { type: "string" } }, execute }],
			globals: [
				...["Any", "Literal", "TypedDict", "list", "str", "int", "float", "bool", "CallToolResult", "Role", "ImageContent", "Required", "Awaitable"].map((name) => ({ name, execute })),
				{ name: "dict.member", inputSchema: { type: "object" }, execute },
				{
					name: "consume", inputSchema: { const: "list" },
					outputSchema: mcpResultSchema({ type: "object", properties: { names: { type: "array", items: { type: "string" } } } }),
					execute,
				},
				{
					name: "explicit",
					signature: '(list: list[Literal["list"]], Literal: dict[str, Any] | None = None) -> CallToolResult[dict[str, Any]]',
					execute,
				},
			],
		});
		expect(shadowed).toContain('async def explicit(list: Codemode_list[Codemode_Literal["list"]], Literal: Codemode_dict[Codemode_str, Codemode_Any] | None = None)');
		const resolved = spawnSync("python3", ["-c", [
			"import sys, typing, types",
			"ns = {}; exec(compile(sys.stdin.read(), 'declarations.py', 'exec'), ns)",
			"for value in tuple(ns.values()):",
			"    if isinstance(value, types.FunctionType): typing.get_type_hints(value, ns)",
			"    if isinstance(value, type):",
			"        for member in vars(value).values():",
			"            if isinstance(member, types.FunctionType): typing.get_type_hints(member, ns, dict(vars(value)))",
			'assert typing.get_type_hints(ns["consume"], ns)["args"] == typing.Literal["list"]',
		].join("\n")], { input: shadowed, encoding: "utf8" });
		expect(resolved.stderr).toBe("");
		expect(resolved.status).toBe(0);
		const refs = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, { $ref: "#/$defs/Shared" }]));
		const limited = schemaToType({ type: "object", properties: refs, $defs: { Shared: { type: "string" } } });
		expect((limited.match(/NotRequired\[str\]/g) ?? []).length).toBe(32);
		expect(limited).toContain("NotRequired[Any]");
	});
});
