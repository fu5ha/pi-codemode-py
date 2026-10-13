/**
 * Reachability scenarios from Pi v1.2.0's test/suite/agent-session-mcp.test.ts.
 * Use the public MCP extension and upstream's in-memory transport with our Python adapter.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { createMcpExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createCodemodeToolDefinition } from "../tool.ts";
import { createHarness } from "./harness.ts";

type Harness = Awaited<ReturnType<typeof createHarness>>;
const harnesses: Harness[] = [];
afterEach(() => { while (harnesses.length) harnesses.pop()!.cleanup(); });

/** Upstream's fake server, narrowed to the one tool these readiness scenarios call. */
function createFakeServer(calls: string[], initializeDelayMs: number) {
	const pair = createInMemoryTransportPair();
	const respond = (request: JsonRpcRequest): unknown => {
		switch (request.method) {
			case "initialize":
				return {
					protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} },
					serverInfo: { name: "docs", version: "1.0.0" },
				};
			case "tools/list":
				return { tools: [{
					name: "search", description: "Search the docs.",
					inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
					outputSchema: {
						type: "object", properties: { hits: { type: "array", items: { type: "string" } } }, required: ["hits"],
					},
				}] };
			case "tools/call": {
				const params = request.params as { name: string; arguments: { query: string } };
				calls.push(`${params.name}:${JSON.stringify(params.arguments)}`);
				const hits = [`${params.arguments.query} guide`, `${params.arguments.query} faq`];
				return { content: [{ type: "text", text: hits.join("\n") }], structuredContent: { hits } };
			}
			default: return {};
		}
	};
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const send = () => void pair.server.send({ jsonrpc: "2.0", id: request.id, result: respond(request) });
		if (request.method !== "initialize" || initializeDelayMs === 0) queueMicrotask(send);
		else if (Number.isFinite(initializeDelayMs)) setTimeout(send, initializeDelayMs);
	});
	return pair;
}

async function setupSlow(initializeDelayMs: number, options: {
	name?: string; factories?: ExtensionFactory[]; initialActiveToolNames?: string[];
} = {}) {
	const calls: string[] = [];
	const harness = await createHarness({
		initialActiveToolNames: options.initialActiveToolNames,
		factories: [
			...(options.factories ?? []),
			createMcpExtension({
				loadConfig: () => ({
					servers: [{ name: options.name ?? "slow", config: { url: "http://unused.invalid" }, source: "test" }],
					errors: [],
				}),
				createTransport: () => {
					const pair = createFakeServer(calls, initializeDelayMs);
					void pair.server.start();
					return pair.client;
				},
			}),
		],
	});
	harnesses.push(harness);
	return { harness, calls };
}

const resultText = (result: { content: { type: string; text?: string }[] }) =>
	result.content.filter((item) => item.type === "text").slice(1).map((item) => item.text).join("\n");

describe("Python codemode MCP reachability", () => {
	it("activates another extension's codemode tool when it reaches other tools", async () => {
		// Pi's auto-activation contract recognizes `codemode`, not our `exec_python` name.
		const { harness } = await setupSlow(0, {
			initialActiveToolNames: [],
			factories: [(pi) => pi.registerTool({ ...createCodemodeToolDefinition(), name: "codemode" })],
		});
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");
		expect(harness.session.getActiveToolNames()).toEqual(["codemode"]);
	});

	it("waits for the servers a codemode script names", async () => {
		const { harness, calls } = await setupSlow(30);
		const result = await harness.run('return (await tools.mcp__slow__search({"query": "q"}))["structuredContent"]');
		expect(result.isError).toBe(false);
		expect(JSON.parse(resultText(result))).toEqual({ hits: ["q guide", "q faq"] });
		expect(calls).toEqual(['search:{"query":"q"}']);
	});

	it("waits for servers whose script identifiers differ from their names", async () => {
		const { harness, calls } = await setupSlow(30, { name: "slow-docs" });
		const result = await harness.run(`
await tools.mcp__slow_docs__search({"query": "q"})
names = ["slow-docs", "slow_docs", "mcp__slow-docs", "mcp__slow_docs"]
return sorted({(await describeNamespace(name))["name"] for name in names})
`);
		expect(result.isError).toBe(false);
		expect(resultText(result)).toBe('["mcp__slow_docs"]');
		expect(calls).toEqual(['search:{"query":"q"}']);
	});

	it("does not wait for servers a codemode script does not name", async () => {
		const { harness } = await setupSlow(Number.POSITIVE_INFINITY);
		expect(resultText(await harness.run("return 1 + 1"))).toBe("2");
	});
});
