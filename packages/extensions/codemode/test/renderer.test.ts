/** Upstream codemode-renderer.test.ts port; rendering semantics are unchanged. */
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
});
