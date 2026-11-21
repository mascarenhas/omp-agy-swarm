// Registers the scripted mock provider in the main session (H21). Loaded with `-e` next to the
// plugin. MOCK_PORT selects the server; costs are nonzero so live spend accounting is visible.

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function mockProvider(pi: ExtensionAPI): void {
	const port = process.env.MOCK_PORT ?? "18765";
	const m = (id: string, efforts: string[] | null) => ({
		id,
		name: `Mock ${id}`,
		reasoning: !!efforts,
		...(efforts ? { thinking: { mode: "effort", efforts } } : {}),
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_000,
	});
	pi.registerProvider("mock", {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		apiKey: "mock-key",
		api: "openai-completions",
		models: [
			m("coord", ["low", "medium", "high"]),
			m("worker-a", ["low", "medium", "high"]),
			m("worker-b", ["low", "medium", "high"]),
			m("worker-limited", ["low", "high"]),
			m("plain", null),
			m("always-429", ["low"]),
		],
	} as unknown as Parameters<ExtensionAPI["registerProvider"]>[1]);
}
