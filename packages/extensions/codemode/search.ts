/** Upstream BM25 discovery core, independent of Pi's unavailable tool-search internals. */
import type { ToolInfo, ToolNamespace } from "@earendil-works/pi-coding-agent";

export const DEFAULT_TOOL_SEARCH_LIMIT = 8;
interface Document { name: string; text: string }
const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "with"]);
function stem(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
}
function tokenize(text: string): string[] {
	return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 0 && !STOP_WORDS.has(term)).map(stem);
}
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function schemaText(schema: unknown, parts: string[]): void {
	if (!isObject(schema)) return;
	if (typeof schema.description === "string") parts.push(schema.description);
	if (isObject(schema.properties)) for (const [name, property] of Object.entries(schema.properties)) {
		parts.push(name);
		schemaText(property, parts);
	}
	schemaText(schema.items, parts);
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const variants = schema[key];
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
	}
}
export function createToolSearchDocument(
	tool: Pick<ToolInfo, "name" | "description" | "parameters">, namespace?: ToolNamespace,
): Document {
	const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
	schemaText(tool.parameters, parts);
	if (namespace) parts.push(namespace.name, namespace.description ?? "", namespace.instructions ?? "");
	return { name: tool.name, text: parts.filter((part) => part.trim()).join(" ") };
}
export class Bm25Ranker {
	rank(query: string, documents: readonly Document[], limit: number): { name: string; score: number }[] {
		const terms = [...new Set(tokenize(query))];
		if (!terms.length || !documents.length || limit <= 0) return [];
		const counts = documents.map((document) => {
			const result = new Map<string, number>();
			for (const term of tokenize(document.text)) result.set(term, (result.get(term) ?? 0) + 1);
			return result;
		});
		const lengths = counts.map((count) => [...count.values()].reduce((sum, count) => sum + count, 0));
		const average = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
		const idf = new Map(terms.map((term) => {
			const frequency = counts.filter((count) => count.has(term)).length;
			return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
		}));
		return documents.map((document, index) => {
			let score = 0;
			for (const term of terms) {
				const count = counts[index].get(term);
				if (!count) continue;
				const norm = 1.2 * (1 - 0.75 + 0.75 * lengths[index] / average);
				score += (idf.get(term) ?? 0) * (count * 2.2 / (count + norm));
			}
			return { name: document.name, score };
		}).filter((match) => match.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
	}
}
