/** Codemode result rendering, including script-focused failure diagnostics. */
import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Component } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import { codemodeRenderers } from "../renderer.ts";
import type { CodemodeToolDetails } from "../tool.ts";

// Rendering is passed a theme by Pi. No import of its private singleton is needed.
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
function render(result: AgentToolResult<CodemodeToolDetails | undefined>, isError = false, expanded = true, width = 200): string {
	const component = codemodeRenderers.renderResult!(result, { expanded, isPartial: false }, theme, {
		args: { code: "" }, toolCallId: "call", invalidate: () => {}, lastComponent: undefined,
		state: {}, cwd: "/", executionStarted: true, argsComplete: true, isPartial: false, expanded, showImages: false, isError,
	}) as Component;
	return stripVTControlCharacters(component.render(width).join("\n")).split("\n").map((line) => line.trimEnd()).join("\n").trim();
}
describe("codemode renderer", () => {
	beforeAll(() => initTheme("dark", false));
	it("hides the script header and shows the output", () => {
		expect(render({
			content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }, { type: "text", text: "hello" }],
			details: { calls: [{ id: "call/1", name: "read", args: '{"path":"a"}', status: "ok", durationMs: 5 }] },
		})).toBe('✓ read {"path":"a"} 5ms\n\nhello');
	});
	it("shows the cost of model calls and their total", () => {
		const call = { name: "models.classify", args: "scorer/judge", status: "ok" as const, durationMs: 5 };
		expect(render({
			content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }],
			details: { calls: [
				{ ...call, id: "call/1", cost: 0.000012936 }, { ...call, id: "call/2", cost: 0.02 }, { ...call, id: "call/3" },
			] },
		})).toBe("✓ models.classify scorer/judge 5ms $0.000013\n✓ models.classify scorer/judge 5ms $0.02\n✓ models.classify scorer/judge 5ms\nModel calls: $0.02");
	});
	it("shows results without a header, such as rejected options", () => {
		expect(render({ content: [{ type: "text", text: "The @options line must be followed by Python source" }], details: undefined }, true))
			.toBe("The @options line must be followed by Python source");
	});
	it("limits collapsed output to wrapped lines, not logical lines", () => {
		const lines = render({
			content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }, { type: "text", text: "x".repeat(1000) }],
			details: { calls: [], fullOutputPath: "/tmp/out.txt" },
		}, false, false, 50).split("\n");
		expect(lines).toHaveLength(7);
		expect(lines.slice(0, 5)).toEqual(Array(5).fill("x".repeat(50)));
		expect(lines[5]).toMatch(/^\.\.\. \(15 more lines,/);
		expect(lines[6]).toBe("Full output: /tmp/out.txt");
	});
	it("prioritizes the failure and script source over ordinary output without nested calls", () => {
		const rendered = render({
			content: [{ type: "text", text: "bootstrap.py library.py hidden traceback" }],
			details: { calls: [], failure: {
				durationMs: 200, error: { kind: "script", name: "NameError", message: "missing",
					stack: 'File "bootstrap.py"\nFile "library.py"',
					diagnostics: [{ name: "NameError", message: "missing", frames: [
						{ line: 12, source: "text(result)" },
					] }],
				},
				output: [{ type: "text", text: "Processing files…" }],
			} },
		}, true, false);
		expect(rendered).toBe("✗ Script failed · 200ms\nNameError: missing\n  codemode.py:12\n  12 │ text(result)\n\nOutput before failure:\nProcessing files…");
		expect(rendered).not.toMatch(/bootstrap|library/);
	});
	it("expands only script frames and preserves exception-chain context", () => {
		const result: AgentToolResult<CodemodeToolDetails> = {
			content: [{ type: "text", text: "raw traceback should not appear" }],
			details: { calls: [], failure: {
				durationMs: 1200, error: { kind: "script", message: "outer", diagnostics: [
					{ name: "ValueError", message: "inner", frames: [{ line: 2, source: "raise ValueError('inner')" }] },
					{ name: "RuntimeError", message: "outer", relation: "cause", frames: [
						{ line: 9, source: "await run()" },
						{ line: 6, source: "raise RuntimeError('outer')", function: "run" },
					] },
				] }, output: [],
			} },
		};
		const collapsed = render(result, true, false);
		expect(collapsed).toContain("RuntimeError: outer");
		expect(collapsed).toContain("codemode.py:6 in run");
		expect(collapsed).toContain("script traceback");
		expect(collapsed).not.toContain("ValueError");
		expect(collapsed).not.toContain("codemode.py:9");
		const expanded = render(result, true);
		expect(expanded).toContain("ValueError: inner");
		expect(expanded).toContain("The above exception caused the following exception:");
		expect(expanded).toContain("codemode.py:9");
		expect(expanded).not.toContain("raw traceback");
	});
	it("shows a syntax-error caret and handles failures without script locations", () => {
		expect(render({
			content: [], details: { calls: [], failure: {
				durationMs: 10, output: [], error: { kind: "script", message: "invalid syntax", diagnostics: [
					{ name: "SyntaxError", message: "invalid syntax", frames: [{ line: 2, source: "b =", column: 4 }] },
				] },
			} },
		}, true)).toContain("  2 │ b =\n    │    ^");
		const timeout = render({
			content: [], details: { calls: [], failure: {
				durationMs: 1000, output: [], error: { kind: "timeout", message: "deadline exceeded" },
			} },
		}, true, false);
		expect(timeout).toContain("Script timed out: deadline exceeded");
		expect(timeout).not.toContain("codemode.py:");
	});
	it("uses exclusive caret ranges and visible columns for Unicode source", () => {
		expect(render({
			content: [], details: { calls: [], failure: {
				durationMs: 10, output: [], error: { kind: "script", message: "invalid syntax", diagnostics: [
					{ name: "SyntaxError", message: "invalid syntax", frames: [{ line: 2, source: "界 = nope", column: 5, endColumn: 9 }] },
				] },
			} },
		}, true)).toContain("    │      ^^^^");
	});
	it("keeps collapsed diagnostics within narrow terminal widths", () => {
		const rendered = render({
			content: [], details: { calls: [], failure: {
				durationMs: 10, output: [], error: { kind: "script", message: "long", diagnostics: [
					{ name: "ValueError", message: "failure ".repeat(50), frames: [{ line: 2, source: "text(" + "x".repeat(100) + ")" }] },
				] },
			} },
		}, true, false, 30);
		expect(rendered.split("\n").every((line) => Array.from(line).length <= 30)).toBe(true);
		expect(rendered).toContain("codemode.py:2");
		expect(rendered).toContain("expand");
	});
});
