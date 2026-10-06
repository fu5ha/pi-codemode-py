/**
 * Ported high-value upstream agent-session-codemode scenarios.
 * VM isolation/memory assertions intentionally omitted: Python is trusted.
 */
import { readFileSync, rmSync } from "node:fs";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHarness } from "./harness.ts";
import { CODEMODE_STORE_ENTRY_TYPE, type CodemodeToolDetails } from "../tool.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const schema = Type.Object({ text: Type.String() });
const echo: ToolDefinition = {
	name: "echo", label: "Echo", description: "Echo text.", parameters: schema,
	execute: async (_id, args) => ({ content: [{ type: "text", text: `echo: ${(args as { text: string }).text}` }], details: {} }),
};
const resultText = (result: { content: { type: string; text?: string }[] }) =>
	result.content.filter((item) => item.type === "text").slice(1).map((item) => item.text).join("\n");
type Harness = Awaited<ReturnType<typeof createHarness>>;
const harnesses: Harness[] = [];
async function setup(options: Parameters<typeof createHarness>[0] = {}) {
	const harness = await createHarness(options);
	harnesses.push(harness);
	return harness;
}
afterEach(() => { while (harnesses.length) harnesses.pop()!.cleanup(); });

describe("Python codemode in the real Pi pipeline", () => {
	it("presents callable tools per codemode.mode without disabling their nested-call availability", async () => {
		const harness = await setup({ tools: [echo] });
		const description = (name: string) => harness.session.agent.state.tools.find((tool) => tool.name === name)?.description ?? "";
		expect(description("echo")).toContain("Codemode: `await tools.echo(args)` returns");
		expect(description("codemode")).not.toContain("### `echo`");
		await harness.run('return await tools.echo({"text": "on"})');
		expect(harness.getRequestTools()).toContain("echo");
		harness.settingsManager.applyOverrides({ codemode: { mode: "only" } });
		harness.session.setActiveToolsByName(["echo", "codemode"]);
		expect(description("codemode")).toContain("### `echo`");
		expect(resultText(await harness.run('return await tools.echo({"text": "only"})'))).toBe("echo: only");
		expect(harness.getRequestTools()).not.toContain("echo");
		expect(harness.getRequestPrompt()).not.toContain("\n- echo: ");
		harness.session.setActiveToolsByName(["echo"]);
		expect(description("echo")).toBe("Echo text.");
	});

	it("calls tools with validation, tool_call/tool_result hooks and parent ids, without nested transcript results", async () => {
		let executed = 0;
		const observed: { name: string; parent?: string }[] = [];
		const harness = await setup({
			tools: [{ ...echo, execute: async (_id, args) => {
				executed++;
				return { content: [{ type: "text", text: String((args as { text: string }).text) }], details: {} };
			} }],
			factories: [(pi) => {
				pi.on("tool_call", (event) => {
					if (event.toolName !== "echo") return;
					observed.push({ name: event.toolName, parent: event.parentToolCallId });
					if ((event.input as { text?: string }).text === "blocked") return { block: true, reason: "permission denied" };
				});
				pi.on("tool_result", (event) => {
					if (event.toolName === "echo" && !event.isError) return { content: [{ type: "text", text: "hooked" }] };
				});
			}],
		});
		const result = await harness.run(`
import os
text(os.getcwd())
text(await tools.echo({"text": "ok"}))
for args in [{"text": "blocked"}, {}]:
    try:
        await tools.echo(args)
    except RuntimeError as error:
        text(str(error))
`);
		expect(result.isError).toBe(false);
		expect(resultText(result)).toContain("hooked");
		expect(resultText(result).toLowerCase()).toContain(harness.tempDir.toLowerCase());
		expect(resultText(result)).toContain("permission denied");
		expect(executed).toBe(1);
		expect(observed.every((event) => event.parent === result.toolCallId)).toBe(true);
		expect(harness.session.messages.filter((message) => message.role === "toolResult" && message.toolName === "echo")).toHaveLength(0);
		expect((result.details as unknown as CodemodeToolDetails).calls.map((call) => call.status)).toEqual(["ok", "error", "error"]);
	});

	it("resolves structured error results but rejects ordinary failures, retaining partial output and traceback", async () => {
		const harness = await setup({ tools: [echo, {
			name: "stats", label: "Stats", description: "Structured failure.", parameters: Type.Object({}),
			outputSchema: Type.Object({ files: Type.Number() }),
			execute: async () => ({
				content: [{ type: "text", text: "failed" }], structuredContent: { files: 2 }, details: {}, isError: true,
				usage: { input: 9, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: { input: 0.005, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.005 } },
			}),
		}] });
		const result = await harness.run('text(await tools.stats({}))\ntext(await tools.echo({"text": "ok"}))\nraise ValueError("boom")');
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain('{"files":2}');
		expect(resultText(result)).toContain("echo: ok");
		expect(resultText(result)).toContain("codemode.py");
		expect(resultText(result)).toContain("ValueError: boom");
		expect((result.details as unknown as CodemodeToolDetails).failure).toMatchObject({
			error: { name: "ValueError", diagnostics: [{ name: "ValueError", frames: [{ line: 3, source: 'raise ValueError("boom")' }] }] },
			output: [{ type: "text", text: '{"files":2}\necho: ok' }],
		});
		expect(result.usage?.input).toBe(9);
		expect(result.usage?.cost.total).toBeCloseTo(0.005);
	});

	it("retains presentation diagnostics even with a tiny output budget", async () => {
		const harness = await setup();
		const result = await harness.run('# @options: {"max_output_tokens": 1}\nprint("x" * 100)\nraise ValueError("important failure")');
		const details = result.details as unknown as CodemodeToolDetails;
		expect(details.calls).toEqual([]);
		expect(details.failure?.error).toMatchObject({
			name: "ValueError", message: "important failure",
			diagnostics: [{ name: "ValueError", frames: [{ line: 3, source: 'raise ValueError("important failure")' }] }],
		});
		expect(details.failure?.output[0].text).toContain("output truncated");
		expect(details.fullOutputPath).toBeTruthy();
		rmSync(details.fullOutputPath!, { force: true });
	});

	it("persists native pickle state only on successful calls, folds branch state, and ignores JSON-store entries", async () => {
		const harness = await setup();
		const increment = 'count = load("count") or 0\nstore("count", count + 1)\nstore("native", {1, 2})\nreturn count + 1';
		expect(resultText(await harness.run(increment))).toBe("1");
		const firstWrite = harness.manager.getBranch().find((entry) => entry.type === "custom" && entry.customType === CODEMODE_STORE_ENTRY_TYPE)!;
		expect(resultText(await harness.run(increment))).toBe("2");
		const entries = harness.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === CODEMODE_STORE_ENTRY_TYPE);
		expect(entries).toHaveLength(2);
		expect((entries[0] as { data: unknown }).data).toMatchObject({ version: 1, encoding: "pickle-base64" });
		expect(resultText(await harness.run('store("count", 9)\nraise ValueError("discard")'))).toContain("discard");
		expect(resultText(await harness.run('return sorted(load("native"))'))).toBe("[1,2]");
		harness.manager.branch(firstWrite.id);
		expect(resultText(await harness.run(increment))).toBe("2");
		harness.manager.appendCustomEntry("codemode-store", { set: { count: 99 }, delete: [] });
		expect(resultText(await harness.run('store("count", None)\nreturn load("count")'))).toBe("null");
		expect(resultText(await harness.run('return load("count")'))).toBe("null");
	});

	it("enforces source deadlines and spills token-limited output while retaining images", async () => {
		const harness = await setup();
		const timedOut = await harness.run('# @options: {"timeout_ms": 300}\nwhile True:\n    pass');
		expect(timedOut.isError).toBe(true);
		expect(resultText(timedOut)).toContain("Script timed out");
		const invalid = await harness.run('# @options: {"yield": 1}\ntext(1)');
		expect(invalid.isError).toBe(true);
		const result = await harness.run(`# @options: {"max_output_tokens": 10}\nfor i in range(100):\n    text(f"row {i}")\nimage("data:image/png;base64,${PNG}")`);
		const path = (result.details as unknown as CodemodeToolDetails).fullOutputPath!;
		expect(path).toBeTruthy();
		expect(resultText(result)).toContain("tokens truncated");
		expect(readFileSync(path, "utf8")).toContain("row 50");
		expect(result.content.at(-1)).toMatchObject({ type: "image", data: PNG });
		const saved = resultText(result).match(/\[Image saved to (.*?) \(/)![1];
		expect(readFileSync(saved).toString("base64")).toBe(PNG);
		rmSync(path, { force: true });
		rmSync(saved, { force: true });
	});

	it("discovers deferred namespace tools using callable Python aliases and Python declarations", async () => {
		const harness = await setup({ tools: [{
			...echo, name: "mcp__test-server__class", exposure: "deferred",
			namespace: { name: "mcp__test-server", description: "Search metadata.", instructions: "Be careful." },
		}] });
		const result = await harness.run(`
matches = await searchTools("Echo", {"namespace": "test-server"})
description = await describeTool(matches[0]["name"])
namespace = await describeNamespace("test-server")
text([matches[0]["name"], "async def" in description, namespace["instructions"]])
return await getattr(tools, matches[0]["name"])({"text": "found"})
`);
		expect(result.isError, resultText(result)).toBe(false);
		expect(resultText(result)).toContain('["mcp__test_server__class",true,"Be careful."]');
		expect(resultText(result)).toContain("echo: found");
	});

	it("uses catalog-auth model resolution, limits concurrency and reports model usage", async () => {
		const harness = await setup();
		let active = 0, maximum = 0;
		const observed: unknown[] = [];
		const imageRequests: unknown[] = [];
		harness.runtime.registerProvider("scorer", {
			apiKey: "secret-key",
			models: [{
				type: "classifier", id: "judge", name: "Judge", api: "test-classifier", baseUrl: "https://classifier.test",
				input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000,
				headers: { "X-Secret": "private" },
			}, {
				type: "image", id: "painter", name: "Painter", api: "test-images", baseUrl: "https://images.test",
				input: ["text", "image"], output: ["image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}],
			images: { "test-images": { generateImages: async (model, context, options) => {
				imageRequests.push([model.baseUrl, options?.apiKey, context.input]);
				return {
					api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason: "stop",
					output: [{ type: "image", data: PNG, mimeType: "image/png" }],
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: { input: 0.04, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.04 } },
				};
			} } },
			classifiers: { "test-classifier": { classify: async (model, context, options) => {
				active++; maximum = Math.max(maximum, active);
				await new Promise((resolve) => setTimeout(resolve, 20));
				active--; observed.push([model.baseUrl, options?.apiKey, context.state]);
				return {
					api: model.api, provider: model.provider, model: model.id, timestamp: 0,
					answers: { approved: { type: "bool", probability: 0.9 } }, stopReason: "stop",
					usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
				};
			} } },
		});
		const result = await harness.run(`
import asyncio
model = await models.getModelOfType("classifier", "scorer", "judge")
listed = await models.getModelsOfType("classifier", None)
assert any(item["provider"] == "scorer" and item["id"] == "judge" for item in listed)
text("headers" in model)
model["baseUrl"] = "https://evil.test"
context = {"state": {}, "questions": {"approved": {"type": "bool", "instructions": "Approval?", "criteria": {"true": "yes", "false": "no"}}}}
results = await asyncio.gather(*(models.classify(model, context) for _ in range(6)))
text([item["answers"]["approved"]["probability"] for item in results])
painter = await models.getModelOfType("image", "scorer", "painter")
painter["baseUrl"] = "https://evil.test"
generated = await models.generateImages(painter, {"input": [{"type": "text", "text": "fox"}]})
for block in generated["output"]:
    image(block)
return generated["stopReason"]
`);
		expect(result.isError).toBe(false);
		expect(resultText(result)).toContain("false");
		expect(maximum).toBe(4);
		expect(observed).toHaveLength(6);
		expect(observed.every((item) => JSON.stringify(item).includes("https://classifier.test") && JSON.stringify(item).includes("secret-key"))).toBe(true);
		expect(imageRequests).toEqual([["https://images.test", "secret-key", [{ type: "text", text: "fox" }]]]);
		expect(result.content.some((item) => item.type === "image" && item.data === PNG)).toBe(true);
		const saved = resultText(result).match(/\[Image saved to (.*?) \(/)![1];
		expect(readFileSync(saved).toString("base64")).toBe(PNG);
		rmSync(saved, { force: true });
		expect(result.usage?.input).toBe(118);
		expect(result.usage?.cost.total).toBeCloseTo(0.046);
		expect(harness.session.getSessionStats().cost).toBeCloseTo(0.046);
	});
});
