// Scripted OpenAI chat-completions SSE server for hermetic runs (§12.3). Per-model rule scripts:
// the first rule whose `when` regex matches the last message (and whose `whenNot` does not, and
// whose `times` budget is not used up) answers; otherwise the model's default, else "OK".
// Every request is logged with its model, reasoning_effort, tool names and message roles.

import { appendFileSync } from "node:fs";

export interface ToolCallSpec {
	name: string;
	args?: Record<string, unknown>;
}

export interface Reply {
	text?: string;
	tools?: ToolCallSpec[];
	status?: number;
	delay?: number;
	/** Thinking text streamed as reasoning_content. */
	thinking?: string;
}

export interface Rule {
	/** Regex (case-sensitive) over the last message: `<role>: <content>`. */
	when?: string;
	/** Regex over the whole conversation (all messages joined). */
	whenAny?: string;
	whenNot?: string;
	times?: number;
	reply: Reply;
}

export interface ModelScript {
	rules: Rule[];
	default?: Reply;
}

export type Script = Record<string, ModelScript>;

export interface LoggedRequest {
	n: number;
	model: string;
	reasoning_effort: unknown;
	hasReasoningField: boolean;
	tools: string[];
	roles: string[];
	last: string;
	rule: number;
	messages: number;
}

interface ChatMessage {
	role: string;
	content?: unknown;
	tool_calls?: { id: string; function: { name: string; arguments: string } }[];
	tool_call_id?: string;
}

function contentText(c: unknown): string {
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map(p => (p && typeof p === "object" && "text" in p ? String(p.text) : "")).join("");
	return "";
}

function render(m: ChatMessage | undefined): string {
	if (!m) return "";
	const calls = m.tool_calls?.map(t => `${t.function.name}(${t.function.arguments})`).join(" ") ?? "";
	return `${m.role}: ${contentText(m.content)}${calls ? ` ${calls}` : ""}`;
}

export class MockLlm {
	readonly log: LoggedRequest[] = [];
	#script: Script;
	#fired = new Map<string, number>();
	#n = 0;
	#server: ReturnType<typeof Bun.serve> | undefined;
	readonly #logFile: string | undefined;

	constructor(script: Script, logFile?: string) {
		this.#script = script;
		this.#logFile = logFile;
	}

	setScript(script: Script): void {
		this.#script = script;
		this.#fired.clear();
	}

	get port(): number {
		return this.#server?.port ?? 0;
	}

	start(port = 0): number {
		this.#server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: req => this.#handle(req) });
		return this.#server.port ?? 0;
	}

	stop(): void {
		this.#server?.stop(true);
	}

	requests(model?: string): LoggedRequest[] {
		return model ? this.log.filter(r => r.model === model) : this.log;
	}

	#pick(model: string, messages: ChatMessage[]): { reply: Reply; rule: number } {
		const script = this.#script[model];
		const last = render(messages[messages.length - 1]);
		const all = messages.map(render).join("\n");
		if (script) {
			for (const [i, r] of script.rules.entries()) {
				const key = `${model}#${i}`;
				const used = this.#fired.get(key) ?? 0;
				if (r.times !== undefined && used >= r.times) continue;
				if (r.when !== undefined && !new RegExp(r.when, "s").test(last)) continue;
				if (r.whenAny !== undefined && !new RegExp(r.whenAny, "s").test(all)) continue;
				if (r.whenNot !== undefined && new RegExp(r.whenNot, "s").test(last)) continue;
				this.#fired.set(key, used + 1);
				return { reply: r.reply, rule: i };
			}
			if (script.default) return { reply: script.default, rule: -1 };
		}
		return { reply: { text: "OK" }, rule: -2 };
	}

	async #handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
		const body = (await req.json()) as {
			model: string;
			messages?: ChatMessage[];
			tools?: { function?: { name?: string } }[];
			reasoning_effort?: unknown;
			stream?: boolean;
		};
		const model = body.model;
		const messages = body.messages ?? [];
		// Composer predictions and title generation also hit the model: answer them plainly.
		const sys = contentText(messages[0]?.content);
		const isAux = !body.tools?.length && messages.length <= 3 && /predict|title|summar/i.test(sys);
		const { reply, rule } = isAux ? { reply: { text: "ok" } as Reply, rule: -3 } : this.#pick(model, messages);
		const entry: LoggedRequest = {
			n: ++this.#n,
			model,
			reasoning_effort: body.reasoning_effort,
			hasReasoningField: "reasoning_effort" in body,
			tools: (body.tools ?? []).map(t => t.function?.name ?? "").filter(Boolean),
			roles: messages.map(m => m.role),
			last: render(messages[messages.length - 1]).slice(0, 400),
			rule,
			messages: messages.length,
		};
		this.log.push(entry);
		if (this.#logFile) appendFileSync(this.#logFile, `${JSON.stringify(entry)}\n`);
		if (reply.status) {
			return new Response(JSON.stringify({ error: { message: reply.text ?? "rate limit exceeded (429): RESOURCE_EXHAUSTED", type: "rate_limit_error" } }), {
				status: reply.status,
				headers: { "content-type": "application/json" },
			});
		}
		const id = `chatcmpl-${entry.n}`;
		const enc = new TextEncoder();
		const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
			`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		const stream = new ReadableStream({
			async start(c) {
				c.enqueue(enc.encode(chunk({ role: "assistant", content: "" })));
				if (reply.delay) await Bun.sleep(reply.delay);
				if (reply.thinking) c.enqueue(enc.encode(chunk({ reasoning_content: reply.thinking })));
				if (reply.text) c.enqueue(enc.encode(chunk({ content: reply.text })));
				(reply.tools ?? []).forEach((t, k) =>
					c.enqueue(
						enc.encode(
							chunk({ tool_calls: [{ index: k, id: `call_${entry.n}_${k}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } }] }),
						),
					),
				);
				c.enqueue(enc.encode(chunk({}, reply.tools?.length ? "tool_calls" : "stop")));
				c.enqueue(
					enc.encode(
						`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
					),
				);
				c.enqueue(enc.encode("data: [DONE]\n\n"));
				c.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	}
}
