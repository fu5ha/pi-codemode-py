/** Python 3.12 hard keywords. Soft keywords (match, case, type, _) remain valid attributes. */
const KEYWORDS = new Set([
	"False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
	"continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
	"if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
	"return", "try", "while", "with", "yield",
]);

export function isPythonIdentifier(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !KEYWORDS.has(name);
}

/** Deterministic ASCII Python alias; preserve leading digits and suffix hard keywords. */
export function toCodemodeIdentifier(name: string): string {
	let identifier = [...name].map((char) => /[A-Za-z0-9_]/.test(char) ? char : "_").join("") || "_";
	if (/^[0-9]/.test(identifier)) identifier = `_${identifier}`;
	return KEYWORDS.has(identifier) ? `${identifier}_` : identifier;
}

/** Tools' implementation attributes and all Python protocol/dunder attributes are reserved. */
export function isReservedNamespaceAttribute(name: string): boolean {
	return name === "_exact" || name === "_aliases" || /^__.*__$/.test(name);
}

export function validateToolNames(tools: readonly { name: string }[]): void {
	const aliases = new Map<string, string>();
	const exact = new Set<string>();
	for (const { name } of tools) {
		if (exact.has(name)) throw new Error(`Tool "${name}" is already registered`);
		const alias = toCodemodeIdentifier(name);
		if (isReservedNamespaceAttribute(name) || isReservedNamespaceAttribute(alias)) {
			throw new Error(`Tool "${name}" conflicts with a reserved namespace attribute`);
		}
		const previous = aliases.get(alias);
		if (previous !== undefined) throw new Error(`Tool "${name}" alias "${alias}" conflicts with tool "${previous}"`);
		aliases.set(alias, name);
		exact.add(name);
	}
}

const RESERVED_GLOBALS = new Set([
	"asyncio", "tools", "ALL_TOOLS", "text", "exit", "store", "load", "__builtins__", "__codemode_main__",
]);

/** Globals keep their explicit spelling; image is the one replaceable built-in helper. */
export function validateGlobalNames(globals: readonly { name: string }[]): void {
	const exact = new Set<string>();
	const namespaces = new Set<string>();
	for (const { name } of globals) {
		const parts = name.split(".");
		if (parts.length > 2 || !parts.every((part) => isPythonIdentifier(part) && !isReservedNamespaceAttribute(part))
			|| RESERVED_GLOBALS.has(parts[0]) || (parts.length === 2 && parts[0] === "image")) {
			throw new Error(`Invalid global name "${name}"`);
		}
		if (exact.has(name)) throw new Error(`Global "${name}" is already registered`);
		if (parts.length === 2) namespaces.add(parts[0]);
		exact.add(name);
	}
	for (const name of namespaces) {
		if (exact.has(name)) throw new Error(`Global "${name}" conflicts with the namespace "${name}"`);
	}
}
