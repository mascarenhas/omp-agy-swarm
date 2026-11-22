import { expect, test } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import { adaptSchemaForStrict, normalizeSchemaForMCP, toolWireSchema, validateJsonSchemaValue, validateToolArguments } from "@oh-my-pi/pi-ai";
import { buildMcpToolDefinitions } from "@oh-my-pi/pi-ai/providers/cursor";
import { convertTools as convertGoogleTools } from "@oh-my-pi/pi-ai/providers/google-shared";
import { convertOpenAICodexResponsesTools } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { decodeJsonValue } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { EFFORTS } from "../../src/env.ts";
import { mainToolDefinitions } from "../../src/tools/main-tools.ts";
import { makeMemberTools } from "../../src/tools/member-tools.ts";
import { callLine } from "../../src/tools/render.ts";
import { buildSchemas } from "../../src/tools/schemas.ts";
import { legacyAdd, paddedAdd, paddedRead, paddedWait } from "../fixtures/zero-filled.ts";
import { Harness } from "../helpers/harness.ts";

const schemas = buildSchemas(zod);
type Tool = keyof typeof schemas;

// Run the same host preflight used for the main and member ToolDefinitions.
function validate(name: Tool, args: Record<string, unknown>) {
	const tool = { name, description: "", parameters: schemas[name] };
	const call = { type: "toolCall" as const, id: "probe", name, arguments: args };
	const parsed = validateToolArguments(tool, call);
	return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined));
}

const swarmEmpty = {
	...paddedAdd,
	name: "\t ",
	brief: "",
	model: "",
	workspace: "",
	role: "",
	discard_ignored: null,
	keep_workspace: null,
	abandon: null,
	limit: 0,
};
const cases: [string, Tool, Record<string, unknown>, Record<string, unknown>][] = [
	["status", "swarm", { ...swarmEmpty, action: "status" }, { action: "status" }],
	["models", "swarm", { ...swarmEmpty, action: "models" }, { action: "models" }],
	["model", "swarm", { ...swarmEmpty, action: "model", effort: " \t", model: "mock/coord" }, { action: "model", model: "mock/coord" }],
	["kill", "swarm", { ...swarmEmpty, action: "kill", name: "probe" }, { action: "kill", name: "probe" }],
	["revive", "swarm", { ...swarmEmpty, action: "revive" }, { action: "revive" }],
	["channel", "swarm", { ...swarmEmpty, action: "channel", op: "create", channel: "build" }, { action: "channel", op: "create", channel: "build" }],
	["title", "swarm", { ...swarmEmpty, action: "title", title: "Build" }, { action: "title", title: "Build" }],
	["finish", "swarm", { ...swarmEmpty, action: "finish", summary: "finished" }, { action: "finish", summary: "finished" }],
	["post_message", "post_message", { text: "  note  ", channel: "\n " }, { text: "  note  " }],
	["read_board", "read_board", { ...paddedRead, status: null }, {}],
	["swarm_wait", "swarm_wait", paddedWait, {}],
];

test.each(cases)("%s pads the same arguments as omission", (_label, tool, padded, minimal) => {
	expect(validate(tool, padded)).toEqual(validate(tool, minimal));
});

test("the padded add starts one worker at inherited effort", async () => {
	const h = new Harness();
	try {
		const codex = { provider: "openai-codex", id: "gpt-6-luna", reasoning: true };
		h.binding.currentModel = codex;
		h.binding.models_ = [codex];
		h.binding.effort = "low";
		// The old effort value is a real setting and conflicts with the selector's suffix.
		const old = await h.swarm(validate("swarm", legacyAdd));
		expect(old.details.error).toBe("effort given twice");
		expect(validate("swarm", paddedAdd)).not.toHaveProperty("effort");
		const result = await h.swarm(validate("swarm", { ...paddedAdd, model: "openai-codex/gpt-6-luna" }));
		expect(result.isError).toBeUndefined();
		expect(result.details.added).toMatchObject([{ name: "probe", effort: "low", role: "worker" }]);
		expect([...h.rt.members.keys()]).toEqual(["coordinator", "probe"]);
	} finally {
		await h.close();
	}
});

test("false, zero cursor, and nonempty values are still explicit choices", () => {
	const read = { since: 0, limit: 50, status: false, channel: "*" };
	const wait = { since: 0, mentions_only: false, timeout_seconds: 1 };
	const add = { action: "add", effort: "off", workspace: "branch", role: "monitor", n: 2, channels: ["main"], tasks: ["build"] };
	expect(validate("read_board", read)).toEqual(read);
	expect(validate("swarm_wait", wait)).toEqual(wait);
	expect(validate("swarm", add)).toEqual(add);
	expect(validate("swarm", { action: "model", model: "mock/coord:off" })).toEqual({ action: "model", model: "mock/coord:off" });
	expect(validate("swarm", { action: "add", role: null, workspace: null, effort: null, op: null, tasks: null, channels: null })).toEqual({ action: "add" });
	expect(() => validate("swarm", { action: "" })).toThrow();
	expect(() => validate("post_message", { text: null })).toThrow();
	expect(() => validate("swarm_wait", { timeout_seconds: -1 })).toThrow();
	expect(() => validate("swarm", { action: "add", effort: "bogus" })).toThrow();
});

test("Codex advertises the empty enum choice first and strict mode adds null", () => {
	const tool = { name: "swarm", description: "", parameters: schemas.swarm };
	const model = {} as Parameters<typeof convertOpenAICodexResponsesTools>[1];
	const [normal] = convertOpenAICodexResponsesTools([tool], model);
	if (normal?.type !== "function") throw new Error("swarm is not a Codex function tool");
	expect(normal.parameters.required).toEqual(["action"]);
	const properties = normal.parameters.properties as Record<string, { enum?: string[] }>;
	for (const name of ["effort", "workspace", "role", "op"]) expect(properties[name]?.enum?.[0]).toBe("");
	expect(properties.effort?.enum).toContain("off");
	// Exercise explicit strictification without depending on the host's PI_NO_STRICT setting.
	const strict = adaptSchemaForStrict(normal.parameters, true);
	expect(strict).toMatchObject({
		strict: true,
		schema: {
			required: expect.arrayContaining(["action", "effort"]),
			properties: { effort: { anyOf: expect.arrayContaining([{ type: "null" }]) } },
		},
	});
});

const enums = {
	action: ["status", "models", "add", "model", "kill", "revive", "finish", "title", "channel"],
	effort: ["", ...EFFORTS],
	workspace: ["", "inherit", "share", "branch"],
	role: ["", "worker", "narrator", "monitor"],
	op: ["", "create", "list", "subscribe", "unsubscribe", "archive"],
};

const fields: Record<Tool, Record<string, string>> = {
	swarm: {
		action: "string", name: "string", brief: "string", model: "string", effort: "string",
		tasks: "array", n: "integer", fork: "string", workspace: "string", channels: "array", role: "string",
		discard_ignored: "boolean", keep_workspace: "boolean", summary: "string", abandon: "boolean", title: "string",
		op: "string", channel: "string", topic: "string", query: "string", provider: "string", limit: "integer",
	},
	post_message: { text: "string", channel: "string" },
	read_board: { since: "integer", limit: "integer", channel: "string", status: "boolean" },
	swarm_wait: { since: "integer", mentions_only: "boolean", timeout_seconds: "integer" },
};

test("main and member schemas survive Claude CCA, Cursor and Antigravity CLI conversion", async () => {
	const h = new Harness();
	try {
		expect((await h.swarm({ action: "add", name: "probe", brief: "probe schemas" })).isError).toBeUndefined();
		const member = h.member("probe");
		const mainTools = mainToolDefinitions({
			schemas, caps: h.deps.caps, env: h.deps.env,
			bind: () => { throw new Error("conversion should not execute or bind the tool"); },
			boundCwd: () => h.binding.cwd, runtime: () => h.rt, ensure: () => h.rt, refusal: () => undefined,
		});
		const memberTools = makeMemberTools(h.rt, member, member.gen, { schemas, caps: h.deps.caps, binding: () => h.binding });
		const claude = { compat: { ccaLegacyParametersSchema: true } } as Parameters<typeof convertGoogleTools>[1];
		for (const tools of [mainTools, memberTools]) {
			const cca = convertGoogleTools(tools, claude)?.[0]?.functionDeclarations ?? [];
			const cursor = buildMcpToolDefinitions(tools, true);
			// Antigravity CLI advertises this schema over MCP and validates incoming args
			// against it before handing the call to the host's argument normalizer.
			const agy = new Map(tools.map(tool => [tool.name, normalizeSchemaForMCP(toolWireSchema(tool))]));
			expect(cca.map(tool => tool.name)).toEqual(Object.keys(fields));
			expect(cursor.map(tool => tool.name)).toEqual(Object.keys(fields));
			expect([...agy.keys()]).toEqual(Object.keys(fields));
			for (const name of Object.keys(fields) as Tool[]) {
				const encoded = cursor.find(tool => tool.name === name)?.inputSchema;
				const ccaParams = cca.find(tool => tool.name === name)?.parameters;
				const cursorParams = encoded && decodeJsonValue(encoded);
				for (const raw of [ccaParams, cursorParams, agy.get(name)]) {
					const schema = raw as { type: string; required?: string[]; properties: Record<string, { type: string | string[]; enum?: string[] }> };
					expect(schema.type).toBe("object");
					expect(schema.required ?? []).toEqual(name === "swarm" ? ["action"] : name === "post_message" ? ["text"] : []);
					expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(fields[name]).sort());
					for (const [key, type] of Object.entries(fields[name])) {
						const prop = schema.properties[key];
						expect(Array.isArray(prop?.type) ? prop.type.filter(t => t !== "null") : [prop?.type]).toEqual([type]);
						if (name === "swarm" && Object.hasOwn(enums, key)) expect(prop?.enum).toEqual(enums[key as keyof typeof enums]);
					}
				}
			}
			for (const [name, payload] of [
				["swarm", paddedAdd],
				["swarm", legacyAdd],
				["swarm", { action: "add", name: null, brief: null, model: null, n: null, fork: null, discard_ignored: null, keep_workspace: null, summary: null, abandon: null, title: null, channel: null, topic: null, query: null, provider: null, limit: null }],
				["post_message", { text: "padding probe", channel: "" }],
				["post_message", { text: "padding probe", channel: null }],
				["read_board", paddedRead],
				["read_board", { since: null, limit: null, channel: null, status: null }],
				["swarm_wait", paddedWait],
				["swarm_wait", { since: null, mentions_only: null, timeout_seconds: null }],
			] as const) {
				expect(validateJsonSchemaValue(agy.get(name), payload)).toMatchObject({ success: true });
			}
		}
	} finally {
		await h.close();
	}
});

test("renderers omit raw null or blank placeholders but show an explicit zero cursor", () => {
	expect(callLine("read_board", { since: null, channel: " " })).toBe("read_board");
	expect(callLine("read_board", { since: 0 })).toBe("read_board after #0");
	expect(callLine("post_message", { text: "hello", channel: " " })).toBe("post");
	expect(callLine("swarm", { action: "model", name: "" })).toBe(callLine("swarm", { action: "model" }));
	expect(callLine("swarm_wait", { timeout_seconds: 0 })).toBe("swarm_wait");
});