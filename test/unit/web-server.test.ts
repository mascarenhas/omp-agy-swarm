// The opt-in web board (§10.4, SW-08): bootstrap exchange, tab bearers, Host/Origin checks,
// methods, headers, frame/file/transcript routes, two boards at once.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TIMING } from "../../src/env.ts";
import { RuntimeReadModel } from "../../src/runtime/read-model.ts";
import { WebBoard } from "../../src/ui/web/server.ts";
import { fastTimers, Harness, REPO, until } from "../helpers/harness.ts";

const hs: Harness[] = [];
const boards: WebBoard[] = [];
beforeAll(() => fastTimers());
afterEach(async () => {
	for (const b of boards.splice(0)) b.stop();
	for (const h of hs.splice(0)) await h.close();
});

async function board(sid?: string) {
	const h = new Harness({ mode: "tui", sid });
	hs.push(h);
	mkdirSync(join(h.dir, "shots"), { recursive: true });
	writeFileSync(join(h.dir, "shots", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	writeFileSync(join(h.dir, "notes.txt"), "file body");
	h.factory.brains.set("ui", async t => {
		await t.call("post_message", { text: `@coordinator [done]\nScreenshot: ${join(h.dir, "shots", "a.png")} | first` });
		await t.call("swarm_wait", {});
	});
	await h.swarm({ action: "add", name: "ui", brief: "x" });
	await until(() => h.member("ui").phase === "parked", 1000, "parked");
	writeFileSync(join(h.dir, "view.json"), JSON.stringify({ attention: [{ id: "a", title: "t", actions: [{ type: "file", target: join(h.dir, "notes.txt") }, { type: "file", target: "/etc/passwd" }] }] }));
	const b = new WebBoard(new RuntimeReadModel(h.rt), { webDir: join(REPO, "web"), swarmDir: h.dir, extraRoots: [] });
	boards.push(b);
	return { h, b };
}

function req(b: WebBoard, path: string, init: RequestInit & { host?: string } = {}) {
	const headers = new Headers(init.headers);
	headers.set("host", init.host ?? `127.0.0.1:${b.port}`);
	return fetch(`http://127.0.0.1:${b.port}${path}`, { ...init, headers });
}

async function tabToken(b: WebBoard): Promise<string> {
	const link = b.link();
	const bootstrap = link.split("#token=")[1] ?? "";
	const r = await req(b, "/api/session", { method: "POST", headers: { authorization: `Bearer ${bootstrap}` } });
	expect(r.status).toBe(200);
	return ((await r.json()) as { token: string }).token;
}

describe("web board", () => {
	test("constructing binds nothing; start binds loopback; stop closes it", async () => {
		const { b } = await board();
		expect(b.running).toBe(false);
		const port = b.start(0);
		expect(port).toBeGreaterThan(0);
		const r = await req(b, "/");
		expect(r.status).toBe(200);
		b.stop();
		await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
	});

	test("Host/Origin matrix, methods, headers, assets", async () => {
		const { b } = await board();
		b.start(0);
		expect((await req(b, "/", { host: `localhost:${b.port}` })).status).toBe(421);
		expect((await req(b, "/", { headers: { origin: "http://evil.example" } })).status).toBe(403);
		expect((await req(b, "/", { headers: { origin: `http://127.0.0.1:${b.port}` } })).status).toBe(200);
		expect((await req(b, "/", { method: "PUT" })).status).toBe(405);
		const html = await req(b, "/");
		expect(html.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(html.headers.get("x-content-type-options")).toBe("nosniff");
		expect(html.headers.get("referrer-policy")).toBe("no-referrer");
		expect(html.headers.get("access-control-allow-origin")).toBeNull();
		expect((await req(b, "/narrator_bootstrap.js")).headers.get("content-type")).toContain("text/plain");
		expect((await req(b, "/../package.json")).status).toBe(404);
		expect((await req(b, "/api/swarm")).status).toBe(401);
		const bad1 = await (await req(b, "/api/swarm")).text();
		const bad2 = await (await req(b, "/nope")).text();
		expect(bad1).toBe(bad2);
	});

	test("bootstrap tokens are single use and expire; tab tokens of one board are rejected by another", async () => {
		const { b } = await board();
		const { b: b2 } = await board("01a1fc2e-0000-0000-0000-00000000000b");
		b.start(0);
		b2.start(0);
		const link = b.link();
		const boot = link.split("#token=")[1] ?? "";
		const r1 = await req(b, "/api/session", { method: "POST", headers: { authorization: `Bearer ${boot}` } });
		expect(r1.status).toBe(200);
		const r2 = await req(b, "/api/session", { method: "POST", headers: { authorization: `Bearer ${boot}` } });
		expect(r2.status).toBe(401);
		const tab = ((await r1.json()) as { token: string }).token;
		expect((await req(b, "/api/swarm", { headers: { authorization: `Bearer ${tab}` } })).status).toBe(200);
		expect((await req(b2, "/api/swarm", { headers: { authorization: `Bearer ${tab}` } })).status).toBe(401);
		const saved = TIMING.bootstrapTokenMs;
		(TIMING as unknown as Record<string, number>).bootstrapTokenMs = 1;
		const stale = b.link().split("#token=")[1] ?? "";
		await Bun.sleep(5); // a real millisecond clock decides bootstrap expiry
		const r3 = await req(b, "/api/session", { method: "POST", headers: { authorization: `Bearer ${stale}` } });
		(TIMING as unknown as Record<string, number>).bootstrapTokenMs = saved;
		expect(r3.status).toBe(401);
	});

	test("snapshot, etag, foreign conversation, frames, files and transcripts", async () => {
		const { h, b } = await board();
		b.start(0);
		const tab = await tabToken(b);
		const auth = { authorization: `Bearer ${tab}` };
		const snap = (await (await req(b, "/api/swarm", { headers: auth })).json()) as Record<string, unknown>;
		expect(snap.conversationId).toBe(h.rt.sid);
		expect(snap.swarm).toBe(h.rt.sid);
		expect(snap.member).toBe("coordinator");
		expect(snap.builtinOverview).toBe(true);
		expect((snap.frames as { path: string }[])[0]?.path).toBe(join(h.dir, "shots", "a.png"));
		const etag = String(snap.etag);
		const un = (await (await req(b, `/api/swarm?etag=${encodeURIComponent(etag)}`, { headers: auth })).json()) as Record<string, unknown>;
		expect(un).toEqual({ conversationId: h.rt.sid, swarm: h.rt.sid, member: "coordinator", unchanged: true, etag });
		const other = (await (await req(b, "/api/swarm?conversationId=other", { headers: auth })).json()) as Record<string, unknown>;
		expect(other.swarm).toBeNull();
		const frame = await req(b, `/api/frame?path=${encodeURIComponent(join(h.dir, "shots", "a.png"))}&seq=2`, { headers: auth });
		expect(frame.status).toBe(200);
		expect(frame.headers.get("content-type")).toBe("image/png");
		expect((await req(b, `/api/frame?path=${encodeURIComponent(join(h.dir, "notes.txt"))}`, { headers: auth })).status).toBe(404);
		const allowed = snap.allowedFiles as Record<string, string>;
		expect(Object.keys(allowed)).toEqual([join(h.dir, "notes.txt")]);
		const file = await req(b, allowed[join(h.dir, "notes.txt")] as string, { headers: auth });
		expect(await file.text()).toBe("file body");
		expect((await req(b, `/api/file?path=${encodeURIComponent("/etc/passwd")}`, { headers: auth })).status).toBe(404);
		const tr = (await (await req(b, "/api/transcript?member=ui", { headers: auth })).json()) as { items: unknown[]; member: string };
		expect(tr.member).toBe("ui");
		expect(tr.items.length).toBeGreaterThan(0);
		expect((await req(b, "/api/transcript?member=../x", { headers: auth })).status).toBe(404);
		b.stop();
	});
});
