import { describe, expect, it } from "vitest";
import { CODEMODE_OPTIONS_PREFIX, CODEMODE_SOURCE_GRAMMAR, CodemodeSourceError, parseCodemodeSource } from "../src/source.ts";

describe("parseCodemodeSource", () => {
	it("returns plain code unchanged", () => {
		expect(parseCodemodeSource("text('hi')")).toEqual({ code: "text('hi')", options: {} });
		expect(parseCodemodeSource("# just a comment\nreturn 1")).toEqual({
			code: "# just a comment\nreturn 1",
			options: {},
		});
	});

	it("parses the options line and keeps line numbers", () => {
		expect(CODEMODE_OPTIONS_PREFIX).toBe("# @options:");
		expect(CODEMODE_SOURCE_GRAMMAR).toContain("OPTIONS_LINE: /[ \\t]*# @options:");
		expect(parseCodemodeSource('# @options: {"timeout_ms": 10}\na = 1\ntext(a)')).toEqual({
			code: "\na = 1\ntext(a)",
			options: { timeoutMs: 10 },
		});
		expect(parseCodemodeSource('  # @options:{"max_output_tokens":0,"timeout_ms":1500}\r\ntext(1)').options).toEqual(
			{
				maxOutputTokens: 0,
				timeoutMs: 1500,
			},
		);
		expect(parseCodemodeSource("# @options: {}\ntext(1)")).toEqual({ code: "\ntext(1)", options: {} });
	});

	it("only treats the first line as an options line", () => {
		const input = 'text(1)\n# @options: {"timeout_ms": 1}';
		expect(parseCodemodeSource(input)).toEqual({ code: input, options: {} });
		expect(parseCodemodeSource("# @optionsx {}\ntext(1)").options).toEqual({});
	});

	it("rejects empty input and invalid options", () => {
		const cases: [string, string | RegExp][] = [
			["", /Expected Python source text \(non-empty\)/],
			["  \n", /Expected Python source text \(non-empty\)/],
			["# @options:\ntext(1)", /@options must be a JSON object with supported fields/],
			["# @options: {timeout_ms: 1}\ntext(1)", /@options must be valid JSON with supported fields/],
			["# @options: [1]\ntext(1)", /@options must be a JSON object with supported fields/],
			[
				'# @options: {"yield": 1}\ntext(1)',
				"@options only supports `max_output_tokens` and `timeout_ms`; got `yield`",
			],
			[
				'# @options: {"max_output_tokens": 1.5}\ntext(1)',
				"@options field `max_output_tokens` must be a non-negative safe integer",
			],
			['# @options: {"timeout_ms": 0}\ntext(1)', /@options field `timeout_ms` must be a positive integer/],
			[
				'# @options: {"timeout_ms": 1}',
				"The @options line must be followed by Python source on subsequent lines",
			],
			[
				'# @options: {"timeout_ms": 1}\n  \n',
				"The @options line must be followed by Python source on subsequent lines",
			],
		];
		for (const [input, message] of cases) {
			expect(() => parseCodemodeSource(input), input).toThrow(CodemodeSourceError);
			expect(() => parseCodemodeSource(input), input).toThrow(message);
		}
	});
});
