/**
 * Presentation for the codemode tool.
 *
 * The call shows the script; the result lists the nested tool calls with their status as they
 * run and the cost of its model calls, followed by script output. Failed executions lead with
 * a compact script-only diagnostic; expansion reveals the remaining script frames, not library
 * or bootstrap internals. Nested calls are not
 * separate tool rows because they never reach the model as tool calls.
 */

import { Container, Spacer, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { keyHint, highlightCode, truncateToVisualLines, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CodemodeNestedCall, CodemodeToolDetails } from "./tool.ts";

const CODE_PREVIEW_LINES = 10;
const CALL_PREVIEW_COUNT = 8;
const OUTPUT_PREVIEW_LINES = 5;
const COLLAPSED_ARGS_CHARS = 80;
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

const replaceTabs = (value: string) => value.replaceAll("\t", "    ");
const str = (value: unknown) => typeof value === "string" ? value : null;

/** Thin component over Pi's public width-aware truncation; no private TUI imports. */
class VisualLinePreview implements Component {
	constructor(private readonly options: {
		text: string; maxVisualLines: number; keep: "start" | "end"; formatHint(hidden: number): string;
	}) {}
	render(width: number): string[] {
		const { text, maxVisualLines, keep, formatHint } = this.options;
		const result = truncateToVisualLines(text, maxVisualLines, width, 0, keep);
		if (!result.skippedCount) return result.visualLines;
		const fullHint = formatHint(result.skippedCount);
		const hint = truncateToWidth(visibleWidth(fullHint) <= width ? fullHint :
			`… ${result.skippedCount} more; ${keyHint("app.tools.expand", "expand")}`, width, "...");
		return keep === "start" ? [...result.visualLines, hint] : [hint, ...result.visualLines];
	}
	invalidate(): void {}
}

function getTextOutput(result: { content: { type: string; text?: string }[] }, showImages: boolean): string {
	return result.content.map((item) => item.type === "text" ? item.text ?? "" :
		item.type === "image" && !showImages ? "[image]" : "").filter(Boolean).join("\n");
}

function expandHint(theme: Theme, hidden: number, noun: string): string {
	return `${theme.fg("muted", `... (${hidden} more ${noun},`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Cents for larger amounts, two significant digits for the fractions of a cent classifier calls cost. */
function formatCost(cost: number): string {
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function statusIcon(call: CodemodeNestedCall, theme: Theme): string {
	switch (call.status) {
		case "running":
			return theme.fg("warning", "…");
		case "ok":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("muted", "⊘");
	}
}

function formatCall(call: CodemodeNestedCall, theme: Theme, expanded: boolean): string {
	const args =
		!expanded && call.args.length > COLLAPSED_ARGS_CHARS
			? `${call.args.slice(0, COLLAPSED_ARGS_CHARS - 3)}...`
			: call.args;
	const duration = formatDuration(call.durationMs);
	let line = `${statusIcon(call, theme)} ${theme.fg("toolTitle", call.name)}`;
	if (args) line += ` ${theme.fg("muted", args)}`;
	if (duration) line += ` ${theme.fg("dim", duration)}`;
	if (call.cost) line += ` ${theme.fg("dim", formatCost(call.cost))}`;
	if (expanded && call.error) line += `\n    ${theme.fg("error", call.error.split("\n").join("\n    "))}`;
	return line;
}

function renderFailure(failure: NonNullable<CodemodeToolDetails["failure"]>, expanded: boolean, theme: Theme): Component {
	const component = new Container();
	const { error } = failure;
	component.addChild(new Text(theme.fg("error", `✗ Script failed · ${formatDuration(failure.durationMs)}`), 0, 0));
	const diagnostics = error.diagnostics?.length ? error.diagnostics : [{
		name: error.name ?? "",
		message: error.kind === "timeout" ? `Script timed out: ${error.message}` :
			error.kind === "aborted" ? `Script aborted: ${error.message}` :
			error.kind === "exec" ? `Python execution failed: ${error.message}` : error.message,
		frames: [],
	}];
	const shown = expanded ? diagnostics : diagnostics.slice(-1);
	for (const diagnostic of shown) {
		if (expanded && diagnostic.relation) {
			component.addChild(new Text(theme.fg("muted", diagnostic.relation === "cause" ?
				"The above exception caused the following exception:" :
				"During handling of the above exception:"), 0, 0));
		}
		const summary = theme.fg("error", `${diagnostic.name ? `${diagnostic.name}: ` : ""}${diagnostic.message}`);
		component.addChild(expanded ? new Text(summary, 0, 0) : new VisualLinePreview({
			text: summary, maxVisualLines: 3, keep: "start",
			formatHint: (hidden) => expandHint(theme, hidden, "error lines"),
		}));
		const frames = expanded ? diagnostic.frames : diagnostic.frames.slice(-1);
		for (const frame of frames) {
			const name = frame.function && frame.function !== "__codemode_main__" ? ` in ${frame.function}` : "";
			const location = theme.fg("muted", `  codemode.py:${frame.line}${name}`);
			const source = replaceTabs(frame.source);
			let text = `${location}\n${theme.fg("toolOutput", `  ${frame.line} │ ${source}`)}`;
			if (frame.column !== undefined) {
				// Columns refer to original Python source; tabs occupy four displayed columns.
				const characters = Array.from(frame.source);
				const prefix = visibleWidth(replaceTabs(characters.slice(0, frame.column - 1).join("")));
				const span = visibleWidth(replaceTabs(characters.slice(frame.column - 1, (frame.endColumn ?? frame.column + 1) - 1).join("")));
				text += `\n${theme.fg("error", `  ${" ".repeat(String(frame.line).length)} │ ${" ".repeat(prefix)}${"^".repeat(Math.max(1, span))}`)}`;
			}
			component.addChild(expanded ? new Text(text, 0, 0) : new VisualLinePreview({
				text, maxVisualLines: 4, keep: "start",
				formatHint: (hidden) => expandHint(theme, hidden, "source lines"),
			}));
		}
	}
	if (!expanded && (diagnostics.length > 1 || diagnostics.at(-1)!.frames.length > 1)) {
		component.addChild(new Text(`${theme.fg("muted", "… script traceback,")} ${keyHint("app.tools.expand", "to expand")}`, 0, 0));
	}
	return component;
}

export const codemodeRenderers: Pick<
	ToolDefinition<any, CodemodeToolDetails | undefined>,
	"renderCall" | "renderResult"
> = {
	renderCall(args, theme, context) {
		// Options remain visible as part of the Python source.
		const code = str((args as { code?: unknown } | undefined)?.code);
		const title = theme.fg("toolTitle", theme.bold("codemode"));
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		if (code === null) {
			component.addChild(new Text(`${title} ${theme.fg("error", "[invalid arg]")}`, 0, 0));
			return component;
		}
		component.addChild(new Text(title, 0, 0));
		if (code) {
			const highlighted = highlightCode(replaceTabs(code.replace(/\r/g, "").trimEnd()), "python").join("\n");
			component.addChild(
				context.expanded
					? new Text(highlighted, 0, 0)
					: new VisualLinePreview({
							text: highlighted,
							maxVisualLines: CODE_PREVIEW_LINES,
							keep: "start",
							formatHint: (hidden) => expandHint(theme, hidden, "lines"),
						}),
			);
		}
		return component;
	},
	renderResult(result, options, theme, context) {
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		const calls = result.details?.calls ?? [];
		const failure = options.isPartial ? undefined : result.details?.failure;
		if (failure) {
			component.addChild(new Spacer(1));
			component.addChild(renderFailure(failure, options.expanded, theme));
		}
		if (calls.length > 0) {
			const shown = options.expanded ? calls : calls.slice(-CALL_PREVIEW_COUNT);
			const lines = shown.map((call) => formatCall(call, theme, options.expanded));
			if (shown.length < calls.length) {
				lines.unshift(
					`${theme.fg("muted", `... (${calls.length - shown.length} earlier calls,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
				);
			}
			// Collapsed rows hide earlier calls, so the total covers every call.
			const priced = calls.filter((call) => call.cost);
			if (priced.length > 1) {
				const total = priced.reduce((sum, call) => sum + (call.cost ?? 0), 0);
				lines.push(theme.fg("muted", `Model calls: ${formatCost(total)}`));
			}
			component.addChild(new Spacer(1));
			component.addChild(new Text(lines.join("\n"), 0, 0));
		}

		// Drop the "Script completed\nWall time ...\nOutput:\n" header. Rejected input (invalid options)
		// has no header.
		const [first, ...rest] = result.content;
		const hasHeader = first?.type === "text" && SCRIPT_HEADER.test(first.text);
		const output = options.isPartial
			? ""
			: getTextOutput({ content: failure ? failure.output : hasHeader ? rest : result.content }, context.showImages).trim();
		if (output) {
			const color = context.isError && !failure ? "error" : "toolOutput";
			const styled = replaceTabs(output)
				.split("\n")
				.map((line) => theme.fg(color, line))
				.join("\n");
			component.addChild(new Spacer(1));
			if (failure) component.addChild(new Text(theme.fg("muted", "Output before failure:"), 0, 0));
			if (options.expanded) {
				component.addChild(new Text(styled, 0, 0));
			} else {
				// Limit wrapped lines, not logical ones: script output is often one long JSON line.
				component.addChild(
					new VisualLinePreview({
						text: styled,
						maxVisualLines: OUTPUT_PREVIEW_LINES,
						keep: "start",
						formatHint: (hidden) => expandHint(theme, hidden, "lines"),
					}),
				);
				// The collapsed preview hides the truncation notice at the end, so name the file here.
				const fullOutputPath = result.details?.fullOutputPath;
				if (fullOutputPath) component.addChild(new Text(theme.fg("muted", `Full output: ${fullOutputPath}`), 0, 0));
			}
		}
		if (failure && result.details?.fullOutputPath && (!output || options.expanded)) {
			component.addChild(new Text(theme.fg("muted", `Full output: ${result.details.fullOutputPath}`), 0, 0));
		}
		return component;
	},
};
