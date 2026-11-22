// The opt-in web board: loopback, GET-only, Host/Origin and filesystem containment,
// response headers, and frame/file/transcript routes.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RuntimeReadModel } from "../../src/runtime/read-model.ts";
import { isLoopbackAuthority, WebBoard } from "../../src/ui/web/server.ts";
import { fastTimers, Harness, REPO, until } from "../helpers/harness.ts";

const hs: Harness[] = [];
const boards: WebBoard[] = [];
beforeAll(() => fastTimers());
afterEach(async () => {
	for (const b of boards.splice(0)) b.stop();
	for (const h of hs.splice(0)) await h.close();
});

async function board() {
	const h = new Harness({ mode: "tui" });
	hs.push(h);
	mkdirSync(join(h.dir, "shots"), { recursive: true });
	writeFileSync(join(h.dir, "shots", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	writeFileSync(join(h.dir, "shots", "unlisted.png"), "not on the reel");
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

describe("web board", () => {
	test("an omitted loopback port denotes only the active scheme's default", () => {
		for (const name of ["127.0.0.1", "LOCALHOST", "[::1]"]) {
			for (const [scheme, port] of [["http", 80], ["https", 443]] as const) {
				expect(isLoopbackAuthority(name, port, scheme)).toBe(true);
				expect(isLoopbackAuthority(`${name}:${port}`, port, scheme)).toBe(true);
				expect(isLoopbackAuthority(name, 40593, scheme)).toBe(false);
				expect(isLoopbackAuthority(name, scheme === "http" ? 443 : 80, scheme)).toBe(false);
				expect(isLoopbackAuthority(`${name}:${port}`, 40593, scheme)).toBe(false);
				expect(isLoopbackAuthority(`${name}:0${port}`, port, scheme)).toBe(false);
				expect(isLoopbackAuthority(`${name}:${port}:${port}`, port, scheme)).toBe(false);
			}
		}
		expect(isLoopbackAuthority("localhost.evil.example", 80, "http")).toBe(false);
	});

	test("constructing binds nothing; start binds loopback; stop closes it", async () => {
		const { b } = await board();
		expect(b.running).toBe(false);
		expect(b.port).toBeUndefined();
		expect(b.link()).toBeUndefined();
		const port = b.start(0);
		expect(port).toBeGreaterThan(0);
		expect(b.link()).toBe(`http://127.0.0.1:${port}/`);
		const r = await req(b, "/");
		expect(r.status).toBe(200);
		b.stop();
		expect(b.port).toBeUndefined();
		expect(b.link()).toBeUndefined();
		await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
		expect(b.start(port)).toBe(port);
		expect(b.link()).toBe(`http://127.0.0.1:${port}/`);
	});

	test("direct and proxied GETs require an allowlisted Host and matching Origin when present", async () => {
		const { b } = await board();
		b.start(0);
		for (const host of [`127.0.0.1:${b.port}`, `localhost:${b.port}`, `[::1]:${b.port}`]) {
			expect((await req(b, "/api/swarm", { host })).status).toBe(200);
			expect((await req(b, "/api/swarm", { host, headers: { origin: `http://${host}` } })).status).toBe(200);
		}
		for (const [host, origin] of [
			["HOST.TAILNET.ts.net", "https://host.tailnet.ts.net"],
			["host.tailnet.ts.net", "https://host.tailnet.ts.net:443"],
			["host.tailnet.ts.net:443", "https://host.tailnet.ts.net"],
			["host.tailnet.ts.net:8443", "https://host.tailnet.ts.net:8443"],
		]) {
			expect((await req(b, "/api/swarm", { host, headers: { origin: origin! } })).status).toBe(200);
		}
		expect((await req(b, "/api/swarm", {
			headers: { origin: `https://127.0.0.1:${b.port}`, "x-forwarded-proto": "https" },
		})).status).toBe(200);

		for (const host of [
			"evil.example", "evil-ts.net", "ts.net", "x.ts.net.evil.com", "x..ts.net",
			"-x.ts.net", "x-.ts.net", `127.0.0.1:1`, "localhost", "user@x.ts.net",
			"x.ts.net:65536", "x.ts.net:", "x.ts.net/path", "x.ts.net,localhost",
		]) {
			expect((await req(b, "/api/swarm", { host })).status).toBe(421);
		}
		for (const [host, origin] of [
			[`127.0.0.1:${b.port}`, "http://evil.example"],
			[`127.0.0.1:${b.port}`, `http://localhost:${b.port}`],
			[`127.0.0.1:${b.port}`, `https://127.0.0.1:${b.port}`],
			["host.ts.net", "http://host.ts.net"],
			["host.ts.net", "https://user@host.ts.net"],
			["host.ts.net", "https://host.ts.net/path"],
			["host.ts.net", "https://other.ts.net"],
			["host.ts.net:8443", "https://host.ts.net"],
			["host.ts.net:8443", "https://host.ts.net:8443:443"],
			["host.ts.net:443", "https://host.ts.net:443:443"],
			["host.ts.net", "https://host.ts.net:"],
			["host.ts.net", "https://host.ts.net:0443"],
			["host.ts.net", "https://host.ts.net/"],
			["host.ts.net", "https://host.ts.net?"],
			["host.ts.net", "https://host.ts.net#"],
			["host.ts.net", "https://host%2ets.net"],
			[`127.0.0.1:${b.port}`, `http://127.0.0.1:${b.port}:80`],
			[`[::1]:${b.port}`, `http://[::1]:${b.port}:80`],
			["host.ts.net", "null"],
		]) {
			expect((await req(b, "/api/swarm", { host, headers: { origin: origin! } })).status).toBe(403);
		}
		expect((await req(b, "/api/swarm", {
			host: "evil.example", headers: { "x-forwarded-host": "host.ts.net", "x-forwarded-proto": "https" },
		})).status).toBe(421);
	});

	test("rejects public Funnel traffic even with an otherwise valid Serve Host and Origin", async () => {
		const { b } = await board();
		b.start();
		const host = "host.tailnet.ts.net";
		for (const path of ["/", "/api/swarm"]) {
			const headers = { origin: `https://${host}`, "x-forwarded-proto": "https" };
			expect((await req(b, path, { host, headers })).status).toBe(200);
			for (const value of ["?1", ""]) {
				expect((await req(b, path, { host, headers: { ...headers, "Tailscale-Funnel-Request": value } })).status).toBe(403);
			}
		}
	});

	test("GET-only methods, response hardening and asset allowlist", async () => {
		const { b } = await board();
		b.start(0);
		for (const method of ["POST", "HEAD", "OPTIONS", "PUT"]) {
			const r = await req(b, "/api/swarm", { method });
			expect(r.status).toBe(405);
			expect(r.headers.get("allow")).toBe("GET");
		}
		expect((await req(b, "/api/session", { method: "POST" })).status).toBe(405);
		expect((await req(b, "/api/session")).status).toBe(404);
		const html = await req(b, "/");
		expect(html.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(html.headers.get("x-content-type-options")).toBe("nosniff");
		expect(html.headers.get("referrer-policy")).toBe("no-referrer");
		expect(html.headers.get("cross-origin-resource-policy")).toBe("same-origin");
		expect(html.headers.get("access-control-allow-origin")).toBeNull();
		const api = await req(b, "/api/swarm");
		expect(api.headers.get("cache-control")).toBe("no-store");
		expect(api.headers.get("access-control-allow-origin")).toBeNull();
		expect((await req(b, "/narrator_bootstrap.js")).headers.get("content-type")).toContain("text/plain");
		expect((await req(b, "/../package.json")).status).toBe(404);
	});

	test("snapshot, etag, foreign conversation, frames, files and transcripts", async () => {
		const { h, b } = await board();
		b.start(0);
		const snap = (await (await req(b, "/api/swarm")).json()) as Record<string, unknown>;
		expect(snap.conversationId).toBe(h.rt.sid);
		expect(snap.swarm).toBe(h.rt.sid);
		expect(snap.member).toBe("coordinator");
		expect(snap.builtinOverview).toBe(true);
		expect((snap.frames as { path: string }[])[0]?.path).toBe(join(h.dir, "shots", "a.png"));
		const etag = String(snap.etag);
		const un = (await (await req(b, `/api/swarm?etag=${encodeURIComponent(etag)}`)).json()) as Record<string, unknown>;
		expect(un).toEqual({ conversationId: h.rt.sid, swarm: h.rt.sid, member: "coordinator", unchanged: true, etag });
		const other = (await (await req(b, "/api/swarm?conversationId=other")).json()) as Record<string, unknown>;
		expect(other.swarm).toBeNull();
		const shot = join(h.dir, "shots", "a.png");
		const framePath = `/api/frame?path=${encodeURIComponent(shot)}&seq=2`;
		const frame = await req(b, framePath);
		expect(frame.status).toBe(200);
		expect(frame.headers.get("content-type")).toBe("image/png");
		const unlisted = join(h.dir, "shots", "unlisted.png");
		expect((await req(b, `/api/frame?path=${encodeURIComponent(unlisted)}`)).status).toBe(404);
		expect((await req(b, `/api/file?path=${encodeURIComponent(unlisted)}`)).status).toBe(404);
		const allowed = snap.allowedFiles as Record<string, string>;
		expect(Object.keys(allowed)).toEqual([join(h.dir, "notes.txt")]);
		const notes = join(h.dir, "notes.txt");
		const filePath = allowed[notes]!;
		const file = await req(b, filePath);
		expect(await file.text()).toBe("file body");
		expect((await req(b, `/api/file?path=${encodeURIComponent("/etc/passwd")}`)).status).toBe(404);
		// The snapshot still allows both paths; read-time containment must reject each
		// path after it is replaced by a symlink outside the roots.
		for (const path of [shot, notes]) {
			unlinkSync(path);
			symlinkSync("/etc/passwd", path);
		}
		expect((await req(b, framePath)).status).toBe(404);
		expect((await req(b, filePath)).status).toBe(404);
		const tr = (await (await req(b, "/api/transcript?member=ui")).json()) as { items: unknown[]; member: string };
		expect(tr.member).toBe("ui");
		expect(tr.items.length).toBeGreaterThan(0);
		expect((await req(b, "/api/transcript?member=../x")).status).toBe(404);
	});
});
