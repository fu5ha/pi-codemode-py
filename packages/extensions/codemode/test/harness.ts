/**
 * Port of upstream test/suite/harness.ts, narrowed to codemode and public SDK APIs.
 * Faux model responses drive the real agent loop, including validation and extension hooks.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerFauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentTools, getCurrentSystemPrompt } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionFactory, type ToolDefinition, type AgentSessionEvent, createCodemodeExtension as createBundledCodemodeExtension,
} from "@earendil-works/pi-coding-agent";
import { createCodemodeExtension } from "../index.ts";

export async function createHarness(options: {
	factories?: ExtensionFactory[]; tools?: ToolDefinition<any>[]; mode?: "on" | "only";
} = {}) {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-python-suite-"));
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, authPath: join(tempDir, "auth.json"), modelsStorePath: join(tempDir, "models-cache.json") });
	runtime.registerProvider(model.provider, {
		apiKey: "faux-key", api: faux.api, baseUrl: model.baseUrl,
		models: faux.models.map((item) => ({ ...item })),
	});
	const loader = new DefaultResourceLoader({
		cwd: tempDir, agentDir: tempDir, noSkills: true, noPromptTemplates: true, noThemes: true,
		additionalExtensionPaths: options.mode ? [] : [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
		extensionFactories: [
			{ name: "codemode", factory: createBundledCodemodeExtension(), builtin: true, replaceable: true },
			...(options.mode ? [createCodemodeExtension({ mode: options.mode })] : []),
			(pi) => { for (const tool of options.tools ?? []) pi.registerTool(tool); },
			...(options.factories ?? []),
		],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
	const manager = SessionManager.inMemory(tempDir);
	const settingsManager = SettingsManager.inMemory({
		defaultTools: ["codemode", ...(options.tools ?? []).filter((tool) => !tool.exposure || tool.exposure === "direct").map((tool) => tool.name)],
	});
	const { session } = await createAgentSession({
		cwd: tempDir, agentDir: tempDir, modelRuntime: runtime, model,
		resourceLoader: loader, sessionManager: manager,
		settingsManager,
	});
	await session.bindExtensions({});
	const events: AgentSessionEvent[] = [];
	let requestTools: string[] = [];
	let requestPrompt = "";
	session.subscribe((event) => events.push(event));
	return {
		session, manager, runtime, settingsManager, tempDir, events,
		getRequestTools: () => requestTools,
		getRequestPrompt: () => requestPrompt,
		async run(code: string) {
			faux.setResponses([
				(context) => {
					requestTools = getCurrentTools(context.messages).map((tool) => tool.name);
					requestPrompt = getCurrentSystemPrompt(context.messages);
					return fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" });
				},
				fauxAssistantMessage("done"),
			]);
			await session.prompt("go");
			const result = session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "codemode");
			if (!result || result.role !== "toolResult") throw new Error("No codemode result");
			return result;
		},
		cleanup() { session.dispose(); faux.unregister(); rmSync(tempDir, { force: true, recursive: true }); },
	};
}
