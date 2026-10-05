import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
	CodemodeExecutionEnv, type CodemodeTool, MAX_OUTPUT_CHARS, MAX_OUTPUT_ITEMS,
	MAX_STORE_TOTAL_BYTES, MAX_STORE_VALUE_BYTES,
} from "../src/index.ts";
import { BOOTSTRAP_SOURCE, RUNNER_SOURCE } from "../src/runtime/python-source.ts";

const environments: CodemodeExecutionEnv[] = [];
function createEnv(tools: CodemodeTool[] = [], timeoutMs = 10_000): CodemodeExecutionEnv {
	const env = new CodemodeExecutionEnv({ tools, timeoutMs });
	environments.push(env);
	return env;
}
function track(env: CodemodeExecutionEnv): CodemodeExecutionEnv { environments.push(env); return env; }
/** Template indentation is test formatting, not part of submitted Python. */
function py(source: string): string {
	const lines = source.replace(/^\n/, "").split("\n");
	const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)?.[0].length ?? 0);
	const indent = Math.min(...indents);
	return lines.map((line) => line.slice(indent)).join("\n");
}
afterEach(async () => { await Promise.all(environments.splice(0).map((env) => env.close())); });
const echo: CodemodeTool = { name: "echo", execute: (args) => args };
const PNG = "iVBORw0KGgo=";
const JPEG = "/9j/4A==";
const GIF = "R0lGODlh";
const WEBP = "UklGRgAAAABXRUJQ";

describe("embedded sources", () => {
	it("compile as Python and match the editable sources", () => {
		for (const [name, source] of [["bootstrap", BOOTSTRAP_SOURCE], ["runner", RUNNER_SOURCE]]) {
			expect(readFileSync(new URL(`../src/runtime/python/${name}.py`, import.meta.url), "utf8").replace(/\r\n/g, "\n")).toBe(source);
			execFileSync("python3", ["-c", "import sys; compile(sys.stdin.read(), '<embedded>', 'exec')"], { input: source });
		}
	});
});

describe("script execution", () => {
	it("returns JSON values, with top-level None mapped to an empty object", async () => {
		const env = createEnv();
		expect(await env.execute("return {'a': 1, 'b': [True, 'x', None]}")).toMatchObject({
			ok: true, value: { a: 1, b: [true, "x", null] }, output: [], calls: [],
		});
		expect(await env.execute("return 'plain'")).toMatchObject({ ok: true, value: "plain" });
		expect(await env.execute("")).toMatchObject({ ok: true, value: {} });
		expect(await env.execute("return None")).toMatchObject({ ok: true, value: {} });
	});

	it("supports top-level await and ordinary Python libraries/timers", async () => {
		const env = createEnv();
		expect(await env.execute("import asyncio, pathlib\nawait asyncio.sleep(0.01)\nreturn pathlib.Path('x').name")).toMatchObject({ ok: true, value: "x" });
	});

	// New regression: textual function wrapping silently changed multiline
	// literals, including strings embedded in nested async functions.
	it("preserves multiline literals while wrapping original-source AST nodes", async () => {
		const source = 'async def nested():\n    return """first\nsecond"""\nreturn [await nested(), f"""value {2}\nnext""", r"""slash\\n\nlast"""]';
		expect(await createEnv().execute(source)).toMatchObject({
			ok: true, value: ["first\nsecond", "value 2\nnext", "slash\\n\nlast"],
		});
	});

	it("collects text, images, stdout and stderr in order, flushing partial lines", async () => {
		const result = await createEnv().execute(py(`
			import sys
			print("hello", 1, {"a": 1})
			text({"json": True})
			text(None)
			text({1, 2})
			image("data:image/png;base64,${PNG}")
			image({"image_url": "data:image/jpeg;base64,${JPEG}"})
			image({"type": "image", "data": "${GIF}", "mimeType": "image/gif"})
			image("data:image/png;base64,${WEBP}")
			image({"type": "image", "data": "${PNG}"})
			print("bad", file=sys.stderr)
			print("partial", end="")
		`));
		expect(result.ok).toBe(true);
		expect(result.output).toEqual([
			{ type: "text", text: "hello 1 {'a': 1}" },
			{ type: "text", text: '{"json":true}' },
			{ type: "text", text: "null" },
			{ type: "text", text: "{1, 2}" },
			{ type: "image", data: PNG, mimeType: "image/png" },
			{ type: "image", data: JPEG, mimeType: "image/jpeg" },
			{ type: "image", data: GIF, mimeType: "image/gif" },
			{ type: "image", data: WEBP, mimeType: "image/webp" },
			{ type: "image", data: PNG, mimeType: "image/png" },
			{ type: "text", text: "bad" },
			{ type: "text", text: "partial" },
		]);
	});

	it("rejects invalid image arguments without producing output", async () => {
		const arguments_ = [
			"", "https://example.com/a.png", "data:image/png,raw",
			{ type: "text", text: "x" }, { type: "image", data: "" }, 42,
			...["AAAA!", "AAAAA", "AA=A", "", "AAAA\n[Output truncated]", "AAAA", "QUJD"].map((data) => `data:image/png;base64,${data}`),
			{ type: "image", data: "AAAA!", mimeType: "image/png" },
			"data:image/jpeg;base64,/9j/9w==",
		];
		const result = await createEnv().execute(py(`
			import json
			errors = []
			for value in json.loads(${JSON.stringify(JSON.stringify(arguments_))}):
			    try:
			        image(value)
			        errors.append("no error")
			    except TypeError as error:
			        errors.append(str(error))
			return errors
		`));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.output).toEqual([]);
		expect(result.value).toHaveLength(arguments_.length);
		expect((result.value as string[]).every((message) => message !== "no error")).toBe(true);
	});

	it("accepts wrapped and large base64 image data", async () => {
		const large = `iVBORw0KGgoA${"QUJD".repeat(256 * 1024)}`;
		const result = await createEnv().execute(`image("data:image/png;base64,iVBORw0K\\r\\nGgo=\\n")\nimage("data:image/png;base64,${large}")`);
		expect(result.ok).toBe(true);
		expect(result.output).toEqual([
			{ type: "image", data: PNG, mimeType: "image/png" },
			{ type: "image", data: large, mimeType: "image/png" },
		]);
	});

	it("ends successfully on exit, keeping output and store writes", async () => {
		const env = createEnv([echo]);
		const result = await env.execute(py(`
			text("before")
			store("k", 1)
			await tools.echo(1)
			try:
			    exit()
			except BaseException:
			    text("caught")
			text("after")
		`));
		expect(result).toMatchObject({ ok: true, value: {}, output: [{ type: "text", text: "before" }] });
		if (result.ok) {
			expect(result.storeWrites.set.k).toBeInstanceOf(Uint8Array);
			expect(await env.execute("return load('k')", { store: result.storeWrites.set })).toMatchObject({ ok: true, value: 1 });
		}
	});

	it("keeps partial output on failure and discards store writes", async () => {
		expect(await createEnv().execute('store("x", 1)\ntext("partial")\nraise RuntimeError("boom")')).toMatchObject({
			ok: false, output: [{ type: "text", text: "partial" }], error: { kind: "script", message: "boom" },
		});
	});

	it("reports syntax errors with the submitted source line", async () => {
		const result = await createEnv().execute("a = 1\nb =\nreturn a");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatchObject({ kind: "script", name: "SyntaxError" });
			expect(result.error.stack).toMatch(/codemode\.py", line 2/);
		}
	});

	it("reports runtime tracebacks with the submitted source line", async () => {
		const result = await createEnv().execute("a = 1\nraise TypeError('boom ' + str(a))");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatchObject({ kind: "script", name: "TypeError", message: "boom 1" });
			expect(result.error.stack).toMatch(/codemode\.py", line 2/);
		}
	});

	it("reports unsupported or non-finite returns as script errors requiring conversion", async () => {
		const env = createEnv();
		for (const source of ["return {1, 2}", "return float('nan')", "return b'bytes'"]) {
			expect(await env.execute(source)).toMatchObject({
				ok: false, error: { kind: "script", name: "TypeError", message: expect.stringContaining("explicitly convert") },
			});
		}
	});
});

describe("tools", () => {
	it("exposes tools as async functions and records calls", async () => {
		const seen: unknown[] = [];
		const env = createEnv([{ name: "add", execute: (args) => {
			seen.push(args); const { a, b } = args as { a: number; b: number }; return { sum: a + b };
		} }]);
		const result = await env.execute(py(`
			first = await tools.add({"a": 1, "b": 2})
			second = await tools.add({"a": first["sum"], "b": 10})
			return second["sum"]
		`));
		expect(result).toMatchObject({ ok: true, value: 13 });
		expect(seen).toEqual([{ a: 1, b: 2 }, { a: 3, b: 10 }]);
		expect(result.calls.map((call) => [call.name, call.status])).toEqual([["add", "ok"], ["add", "ok"]]);
		expect(result.calls.every((call) => call.durationMs >= 0)).toBe(true);
	});

	it("runs concurrent calls and lists tool names", async () => {
		const env = createEnv([echo, { name: "delay", execute: (args) => new Promise((resolve) => setTimeout(() => resolve(args), 20)) }]);
		expect(await env.execute("import asyncio\nvalues = await asyncio.gather(tools.delay(1), tools.delay(2), tools.echo(3))\nreturn {'values': values, 'names': list(tools)}"))
			.toMatchObject({ ok: true, value: { values: [1, 2, 3], names: ["echo", "delay"] } });
	});

	it("exposes normalized aliases, exact-name lookup, and ALL_TOOLS", async () => {
		const env = createEnv([
			{ name: "my-tool", description: "Dashes", execute: () => "dash" },
			{ name: "mcp__docs__search", execute: () => "mcp" },
			{ name: "1tool", execute: () => "digit" },
			{ name: "class", execute: () => "keyword" },
			{ name: "$tool", execute: () => "dollar" },
		]);
		expect(await env.execute("return {'all': ALL_TOOLS, 'calls': [await tools.my_tool(), await tools['my-tool'](), await tools.mcp__docs__search(), await tools._1tool(), await tools.class_(), await tools['class'](), await tools._tool()]}"))
			.toMatchObject({ ok: true, value: {
				all: [
					{ name: "my_tool", description: "Dashes" }, { name: "mcp__docs__search", description: "" },
					{ name: "_1tool", description: "" }, { name: "class_", description: "" }, { name: "_tool", description: "" },
				],
				calls: ["dash", "dash", "mcp", "digit", "keyword", "keyword", "dollar"],
			} });
	});

	it("passes omitted arguments and undefined host results as None", async () => {
		const env = createEnv([{ name: "noop", execute: () => undefined }]);
		expect(await env.execute("return [await tools.noop(), await tools.noop(None)]")).toMatchObject({ ok: true, value: [null, null] });
	});

	it("turns host errors into catchable RuntimeErrors", async () => {
		const env = createEnv([{ name: "fail", execute: () => { throw new Error("tool exploded"); } }]);
		const result = await env.execute(py(`
			try:
			    await tools.fail()
			except RuntimeError as error:
			    return str(error)
		`));
		expect(result).toMatchObject({ ok: true, value: "tool exploded", calls: [{ name: "fail", status: "error" }] });
	});

	it("names close matches and rejects calls to unknown tools", async () => {
		const env = createEnv([echo, { name: "web-search", execute: () => "" }]);
		const result = await env.execute("return await tools.Echo()");
		expect(result).toMatchObject({ ok: false, error: { kind: "script", name: "AttributeError", message: expect.stringContaining("Did you mean tools.echo?") } });
		expect(await env.execute("return ['echo' in tools, 'nothing' in tools]")).toMatchObject({ ok: true, value: [true, false] });
	});

	it("cancels scheduled background calls, but never dispatches unawaited coroutines", async () => {
		let aborted = false;
		let observed = 0;
		const env = createEnv([{ name: "slow", execute: (_args, { signal }) => {
			observed++;
			return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }));
		} }]);
		const result = await env.execute("import asyncio\nunused = tools.slow()\nunused.close()\nasyncio.create_task(tools.slow())\nawait asyncio.sleep(0.02)\nreturn 'early'");
		expect(result).toMatchObject({ ok: true, value: "early", calls: [{ name: "slow", status: "cancelled" }] });
		expect(observed).toBe(1);
		expect(aborted).toBe(true);
	});

	it("supports register and unregister between executions", async () => {
		const env = createEnv();
		env.registerTool(echo);
		expect(() => env.registerTool(echo)).toThrow(/already registered/);
		for (const name of ["_exact", "_aliases", "__dict__", "__getitem__", "__class__"]) {
			expect(() => env.registerTool({ name, execute: () => "" })).toThrow(/reserved namespace/);
		}
		env.registerTool({ name: "foo-bar", execute: () => "first" });
		expect(() => env.registerTool({ name: "foo_bar", execute: () => "second" })).toThrow(/alias.*conflicts/);
		expect(env.unregisterTool("foo-bar")).toBe(true);
		env.registerTool({ name: "foo_bar", execute: () => "second" });
		expect(await env.execute("return await tools.foo_bar()")).toMatchObject({ ok: true, value: "second" });
		env.unregisterTool("foo_bar");
		expect(env.tools.map((tool) => tool.name)).toEqual(["echo"]);
		expect(await env.execute("return await tools.echo('a')")).toMatchObject({ ok: true, value: "a" });
		expect(env.unregisterTool("echo")).toBe(true);
		expect(await env.execute("return 'echo' in tools")).toMatchObject({ ok: true, value: false });
	});
});

describe("store and load", () => {
	it("reads pickle snapshots and reports writes and deletions", async () => {
		const env = createEnv();
		const initial = await env.execute("store('counter', 41)\nstore('old', 'x')");
		expect(initial.ok).toBe(true);
		if (!initial.ok) return;
		const result = await env.execute(py(`
			seen = load("counter")
			store("counter", seen + 1)
			store("list", [1, {"a": None}])
			store("old", None)
			return [seen, load("counter"), load("missing"), load("old")]
		`), { store: initial.storeWrites.set });
		expect(result).toMatchObject({ ok: true, value: [41, 42, null, null], storeWrites: { delete: ["old"] } });
		if (result.ok) {
			expect(await env.execute("return [load('counter'), load('list')]", { store: result.storeWrites.set }))
				.toMatchObject({ ok: true, value: [42, [1, { a: null }]] });
		}
	});

	it("copies native pickle values on load and snapshots values on store", async () => {
		const env = createEnv();
		const initial = await env.execute("store('obj', {'a': 1})");
		if (!initial.ok) throw new Error(initial.error.message);
		const result = await env.execute(py(`
			value = load("obj")
			value["a"] = 2
			kept = {1, 2}
			store("kept", kept)
			kept.add(3)
			return [load("obj")["a"], sorted(load("kept"))]
		`), { store: initial.storeWrites.set });
		expect(result).toMatchObject({ ok: true, value: [1, [1, 2]] });
	});

	it("rejects invalid keys, unpicklable values, and oversized writes inside Python", async () => {
		const result = await createEnv().execute(py(`
			def attempt(fn):
			    try:
			        fn()
			        return "ok"
			    except Exception as error:
			        return type(error).__name__
			def fill():
			    for i in range(11):
			        store(str(i), "x" * (200 * 1024))
			return [
			    attempt(lambda: store(1, "x")),
			    attempt(lambda: load({})),
			    attempt(lambda: store("fn", lambda: 1)),
			    attempt(lambda: store("big", "x" * (300 * 1024))),
			    attempt(fill),
			]
		`));
		expect(result).toMatchObject({ ok: true, value: ["TypeError", "TypeError", "AttributeError", "ValueError", "ValueError"] });
		expect(MAX_STORE_VALUE_BYTES).toBe(256 * 1024);
		expect(MAX_STORE_TOTAL_BYTES).toBe(2 * 1024 * 1024);
	});

	it("explains oversized writes in serialized pickle bytes", async () => {
		const result = await createEnv().execute("store('img', 'x' * (300 * 1024))");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("pickle bytes; limit is 262144");
			expect(result.error.message).toContain("Show images with image()");
		}
	});
});

describe("globals", () => {
	it("exposes globals without recording calls; unscheduled coroutines do not execute", async () => {
		const seen: unknown[] = [];
		const env = track(new CodemodeExecutionEnv({ tools: [echo], globals: [{ name: "attach", execute: (args) => void seen.push(args) }] }));
		const result = await env.execute("await attach({'ref': 1})\nunused = attach('not awaited')\nunused.close()\nreturn [callable(attach), await tools.echo(2)]");
		expect(result).toMatchObject({ ok: true, value: [true, 2] });
		expect(result.calls.map((call) => call.name)).toEqual(["echo"]);
		expect(seen).toEqual([{ ref: 1 }]);
	});

	it("groups globals in mutable Python namespaces and spreads arguments on request", async () => {
		const seen: unknown[] = [];
		const env = track(new CodemodeExecutionEnv({ globals: [
			{ name: "models.list", spread: true, execute: (args) => void seen.push(args) },
			{ name: "models.first", execute: (args) => args },
		] }));
		const result = await env.execute("await models.list('classifier', None, 3)\nawait models.list()\nmodels.extra = 1\nreturn [list(vars(models)), await models.first('a', 'ignored'), models.extra]");
		expect(result).toMatchObject({ ok: true, value: [["list", "first", "extra"], "a", 1] });
		expect(seen).toEqual([["classifier", null, 3], []]);
	});

	it("rejects invalid, reserved, and conflicting global names", () => {
		const execute = () => undefined;
		for (const name of ["a.b.c", "a.", ".a", "tools.x", "store.x", "a.not-valid", "not-valid", "tools", "store", "load", "class", "models.for", "models.__dict__", "__class__.x", "image.member"]) {
			expect(() => new CodemodeExecutionEnv({ globals: [{ name, execute }] }), name).toThrow(/Invalid global/);
		}
		expect(() => new CodemodeExecutionEnv({ globals: [{ name: "models", execute }, { name: "models.list", execute }] })).toThrow(/conflicts with the namespace/);
	});
});

describe("limits and lifetime", () => {
	it("terminates synchronous and coroutine-spinning loops on timeout", async () => {
		const env = createEnv();
		const started = performance.now();
		for (const source of ["while True: pass", "import asyncio\nwhile True: await asyncio.sleep(0)"]) {
			expect(await env.execute(source, { timeoutMs: 500 })).toMatchObject({ ok: false, error: { kind: "timeout" } });
		}
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	it("allows timers with no deadline and does not mistake idle asyncio for a stall", async () => {
		expect(await createEnv().execute("import asyncio\nawait asyncio.sleep(0.05)\nreturn 'late'", { timeoutMs: Infinity })).toMatchObject({ ok: true, value: "late" });
	});

	it("aborts via signal, cancels host calls, and close aborts all active executions", async () => {
		let toolSignal: AbortSignal | undefined;
		let called: () => void = () => {};
		const nextCall = () => new Promise<void>((resolve) => { called = resolve; });
		const env = createEnv([{ name: "hang", execute: (_args, { signal }) => {
			toolSignal = signal; called(); return new Promise(() => {});
		} }]);
		const firstCall = nextCall();
		const promise = env.execute("await tools.hang()");
		await firstCall;
		const already = new AbortController();
		already.abort(new Error("user cancelled"));
		expect(await env.execute("await tools.hang()", { signal: already.signal })).toMatchObject({ ok: false, error: { kind: "aborted", message: "user cancelled" } });
		expect(toolSignal?.aborted).toBe(false);
		const controller = new AbortController();
		const secondCall = nextCall();
		const pending = env.execute("await tools.hang()", { signal: controller.signal });
		await secondCall;
		controller.abort();
		expect(await pending).toMatchObject({ ok: false, error: { kind: "aborted" }, calls: [{ name: "hang", status: "cancelled" }] });
		expect(toolSignal?.aborted).toBe(true);
		await env.close();
		expect(await promise).toMatchObject({ ok: false, error: { kind: "aborted", message: "Execution environment closed" } });
	});

	it("fails output overflow even when Python catches the error", async () => {
		const env = createEnv();
		for (const expression of ["text(s)", "print(s)", 'image("data:image/png;base64," + p)']) {
			const result = await env.execute(py(`
				s = "x" * (1 << 20)
				p = "iVBORw0KGgoA" + "A" * (1 << 20)
				while True:
				    try:
				        ${expression}
				    except Exception:
				        pass
			`));
			expect(result).toMatchObject({ ok: false, error: { kind: "script", name: "ValueError", message: expect.stringContaining("script output exceeded") } });
			const chars = result.output.reduce((sum, item) => sum + (item.type === "text" ? item.text.length : item.data.length), 0);
			expect(chars).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
			expect(chars).toBeGreaterThan(MAX_OUTPUT_CHARS - (2 << 20));
		}
		const empty = await env.execute('while True: text("")');
		expect(empty).toMatchObject({ ok: false, error: { name: "ValueError" } });
		expect(empty.output).toHaveLength(MAX_OUTPUT_ITEMS);
	}, 30_000);

	it("rejects execute after close", async () => {
		const env = createEnv();
		await env.close();
		await expect(env.execute("return 1")).rejects.toThrow(/closed/);
	});

	it("runs executions in parallel without sharing Python state", async () => {
		const env = createEnv();
		const results = await Promise.all([
			env.execute("import builtins, asyncio\nbuiltins.shared = 'a'\nawait asyncio.sleep(0.01)\nreturn builtins.shared"),
			env.execute("import builtins, asyncio\nbuiltins.shared = 'b'\nawait asyncio.sleep(0.01)\nreturn builtins.shared"),
			env.execute("import builtins\nreturn hasattr(builtins, 'shared')"),
		]);
		expect(results.map((result) => result.ok ? result.value : result.error)).toEqual(["a", "b", false]);
	});

	it("turns deep recursion into a catchable Python RecursionError", async () => {
		expect(await createEnv().execute(py(`
			def dive():
			    dive()
			try:
			    dive()
			except RecursionError as error:
			    return type(error).__name__
		`))).toMatchObject({ ok: true, value: "RecursionError" });
	});

	it("reports abrupt backend exit as an execution error", async () => {
		expect(await createEnv().execute("import os\nos._exit(7)")).toMatchObject({ ok: false, error: { kind: "exec" } });
	});

	// New: cancellation-resistant tasks are a real process-lifecycle hazard, not
	// an elementary coroutine test. Done must arrive without asyncio.run hanging.
	it("bounds cleanup when a background task suppresses cancellation", async () => {
		const env = createEnv();
		for (const cancellationHandler of ["continue", "time.sleep(60)", "while True: pass"]) {
			const started = performance.now();
			expect(await env.execute(py(`
				import asyncio, time
				async def resistant():
				    while True:
				        try:
				            await asyncio.sleep(10)
				        except asyncio.CancelledError:
				            ${cancellationHandler}
				asyncio.create_task(resistant())
				await asyncio.sleep(0.01)
				return "done"
			`), { timeoutMs: Infinity })).toMatchObject({ ok: true, value: "done" });
			expect(performance.now() - started).toBeLessThan(3_000);
		}
	});

	// New: exercise actual Job Object/process-group cleanup, non-inherited job
	// handles, and abrupt runner/host death. POSIX zombies are dead processes,
	// even if the system's orphan reaper has not yet removed their PID entries.
	it("kills runner, child and grandchild on success, timeout, abort, runner crash and host death", async () => {
		function alive(pid: number): boolean {
			try {
				process.kill(pid, 0);
				if (process.platform === "linux") {
					const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
					return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
				}
				if (process.platform !== "win32") {
					return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
				}
				return true;
			} catch { return false; }
		}
		for (const mode of ["success", "timeout", "abort", "crash", "hostDeath"]) {
			let pids: number[] = [];
			const controller = new AbortController();
			const env = createEnv([{ name: "observe", execute: (args) => {
				pids = args as number[];
				expect(pids.every(alive)).toBe(true);
				if (mode === "abort") controller.abort();
			} }]);
			const childSource = "import subprocess,sys,os,time,json; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'], close_fds=False); print(json.dumps([os.getpid(),p.pid]),flush=True); time.sleep(60)";
			const ending = mode === "crash" ? "os._exit(7)" : ["timeout", "abort", "hostDeath"].includes(mode) ? "time.sleep(60)" : "return 'done'";
			const source = py(`
				import subprocess, sys, json, time, os
				child = subprocess.Popen([sys.executable, "-c", ${JSON.stringify(childSource)}], stdout=subprocess.PIPE, text=True, close_fds=False)
				await tools.observe([os.getpid(), *json.loads(child.stdout.readline())])
				${ending}
			`);
			if (mode === "hostDeath") {
				const runtime = new URL("../src/runtime/host.ts", import.meta.url).href;
				const hostSource = `import {CodemodeExecutionEnv} from ${JSON.stringify(runtime)}; const env=new CodemodeExecutionEnv({tools:[{name:"observe",execute:(pids)=>console.log(JSON.stringify(pids))}]}); await env.execute(${JSON.stringify(source)});`;
				const host = spawn(process.execPath, ["--input-type=module", "-e", hostSource], { stdio: ["ignore", "pipe", "inherit"] });
				try {
					pids = await new Promise<number[]>((resolve, reject) => {
						const timer = setTimeout(() => reject(new Error("external host never reported its process tree")), 5_000);
						let output = "";
						host.stdout.on("data", (chunk) => {
							output += String(chunk);
							if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.trim()) as number[]); }
						});
						host.on("error", (error) => { clearTimeout(timer); reject(error); });
					});
					expect(pids.every(alive)).toBe(true);
				} finally {
					host.kill();
				}
			} else {
				const result = await env.execute(source, { signal: controller.signal, timeoutMs: mode === "timeout" ? 1500 : 10_000 });
				if (mode === "success") expect(result).toMatchObject({ ok: true, value: "done" });
				else expect(result).toMatchObject({ ok: false, error: { kind: mode === "crash" ? "exec" : mode === "timeout" ? "timeout" : "aborted" } });
			}
			expect(pids).toHaveLength(3);
			for (let attempt = 0; attempt < 50 && pids.some(alive); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
			expect(pids.map(alive)).toEqual([false, false, false]);
		}
	}, 20_000);
});
