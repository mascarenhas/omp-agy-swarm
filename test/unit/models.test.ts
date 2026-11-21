// §4.1–4.2 resolution and effort (with the SW-14 explicit alias-suffix parsing).

import { describe, expect, test } from "bun:test";
import { resolveEffort, resolveSpec } from "../../src/runtime/models.ts";
import type { ModelInfo } from "../../src/runtime/ports.ts";
import { fakeCaps } from "../helpers/harness.ts";

const LIST: ModelInfo[] = [
	{ provider: "zai", id: "glm-4.7:max", reasoning: true },
	{ provider: "ollama", id: "qwen3:8b", reasoning: true },
	{ provider: "or", id: "x:free", reasoning: true },
	{ provider: "odd", id: "literal:low", reasoning: true },
	{ provider: "odd", id: "literal", reasoning: true },
	{ provider: "anthropic", id: "claude-haiku-5-5", reasoning: true },
	{ provider: "openrouter", id: "claude-haiku-5-5", reasoning: true },
	{ provider: "mock", id: "worker-b", reasoning: true },
	{ provider: "mock", id: "worker-limited", reasoning: true },
	{ provider: "mock", id: "plain", reasoning: false },
];
const alias = (s: string) => (s === "@smol" ? LIST[7] : undefined);
const ok = (spec: string, caller?: ModelInfo) => {
	const r = resolveSpec(spec, LIST, caller, alias);
	if ("error" in r) throw new Error(r.error);
	return r;
};

describe("resolveSpec", () => {
	test("literal ids containing colons win before any effort split", () => {
		expect(ok("zai/glm-4.7:max").model.id).toBe("glm-4.7:max");
		expect(ok("glm-4.7:max").suffixEffort).toBeUndefined();
		expect(ok("qwen3:8b").model.provider).toBe("ollama");
		expect(ok("x:free").model.id).toBe("x:free");
		expect(ok("odd/literal:low").model.id).toBe("literal:low");
		expect(ok("odd/literal:low").suffixEffort).toBeUndefined();
	});

	test("a tagged id plus an effort suffix", () => {
		const r = ok("zai/glm-4.7:max:high");
		expect(r.model.id).toBe("glm-4.7:max");
		expect(r.suffixEffort).toBe("high");
	});

	test("bare ambiguity prefers the caller's provider, else fails with choices", () => {
		expect(ok("claude-haiku-5-5", { provider: "openrouter", id: "x" }).model.provider).toBe("openrouter");
		const r = resolveSpec("claude-haiku-5-5", LIST, { provider: "mock", id: "x" }, alias);
		expect("error" in r && r.error).toContain("ambiguous model id; use one of: anthropic/claude-haiku-5-5, openrouter/claude-haiku-5-5");
	});

	test("qualified unknown fails closed with suggestions; auto is rejected", () => {
		const r = resolveSpec("anthropic/claude-haiku-9", LIST, undefined, alias);
		expect("error" in r && r.error).toContain("unknown model anthropic/claude-haiku-9");
		expect("error" in r && r.error).toContain("anthropic/claude-haiku-5-5");
		const a = resolveSpec("mock/worker-b:auto", LIST, undefined, alias);
		expect("error" in a && a.error).toBe("auto effort is not supported");
	});

	test("@role aliases resolve through the host; suffixes are parsed explicitly", () => {
		const r = ok("@smol:high");
		expect(r.model.id).toBe("worker-b");
		expect(r.suffixEffort).toBe("high");
		expect(r.notes[0]).toContain("alias @smol → mock/worker-b");
		const bad = resolveSpec("@smol:fast", LIST, undefined, alias);
		expect("error" in bad && bad.error).toContain('invalid effort suffix ":fast"');
		const none = resolveSpec("@nope", LIST, undefined, alias);
		expect("error" in none).toBe(true);
	});
});

describe("resolveEffort", () => {
	test("clamps with a note; non-reasoning is off; inherit passes undefined", () => {
		const lim = LIST[8] as ModelInfo;
		expect(resolveEffort(fakeCaps, lim, "medium")).toEqual({ effort: "low", note: "mock/worker-limited supports low, high; 'medium' → 'low'" });
		expect(resolveEffort(fakeCaps, lim, "high")).toEqual({ effort: "high" });
		expect(resolveEffort(fakeCaps, lim, "off")).toEqual({ effort: "off" });
		expect(resolveEffort(fakeCaps, lim, undefined)).toEqual({ effort: undefined });
		const plain = LIST[9] as ModelInfo;
		expect(resolveEffort(fakeCaps, plain, "high").effort).toBe("off");
		expect(resolveEffort(fakeCaps, plain, "high").note).toContain("does not reason");
	});
});
