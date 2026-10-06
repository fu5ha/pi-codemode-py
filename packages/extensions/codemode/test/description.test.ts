import { describe, expect, it } from "vitest";
import { createCodemodeDescription } from "../tool.ts";

describe("Python codemode description", () => {
	it("explains success-only persistence when first introducing store/load", () => {
		const description = createCodemodeDescription([]);
		const introduction = description.split("\n").find((line) => line.startsWith("- `store(key, value)`"));
		expect(introduction).toContain("pending until the whole script succeeds");
		expect(introduction).toContain("if it fails for any reason (including return-value serialization)");
		expect(introduction).toContain("all pending store updates are discarded");
		expect(introduction).toContain("previously persisted values remain unchanged");
	});
});
