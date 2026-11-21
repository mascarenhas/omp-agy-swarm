// The opt-in web board (§10.4): loopback only, constructed only by /swarm-ui start (or the first
// add in a tui/rpc session with OMP_SWARM_UI=1). No cookies: a one-time #token= fragment is
// exchanged for an in-memory per-tab bearer sent as an Authorization header. No credential ever
// appears in a URL, a tool result, the board, metrics, a file or stderr.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS, TIMING } from "../../env.ts";
import type { SwarmReadModel } from "../model.ts";
import { canonicalRoots, safeRead } from "../view-files.ts";
import { SnapshotBuilder } from "./snapshot.ts";

const ASSETS: Record<string, [string, string]> = {
	"/": ["index.html", "text/html; charset=utf-8"],
	"/preload.js": ["preload.js", "application/javascript; charset=utf-8"],
	"/omp-bridge.js": ["omp-bridge.js", "application/javascript; charset=utf-8"],
	"/omp-bridge.css": ["omp-bridge.css", "text/css; charset=utf-8"],
	"/app.js": ["vendor/app.js", "application/javascript; charset=utf-8"],
	"/hive.js": ["vendor/hive.js", "application/javascript; charset=utf-8"],
	"/styles.css": ["vendor/styles.css", "text/css; charset=utf-8"],
	"/hive.css": ["vendor/hive.css", "text/css; charset=utf-8"],
	"/narrator_bootstrap.js": ["vendor/narrator_bootstrap.js", "text/plain; charset=utf-8"],
};

const FRAME_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

const HTML_CSP =
	"frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; connect-src 'self'; img-src 'self' blob: data:";

const REFUSED = "request refused";

function token(): string {
	return randomBytes(32).toString("base64url");
}

function sameToken(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

export interface WebBoardOptions {
	webDir: string;
	swarmDir: string;
	extraRoots: readonly string[];
}

export class WebBoard {
	readonly #model: SwarmReadModel;
	readonly #assets = new Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>();
	readonly #roots: string[];
	readonly #snap: SnapshotBuilder;
	#server: ReturnType<typeof Bun.serve> | undefined;
	#port = 0;
	#bootstrap = new Map<string, number>();
	#tabs: string[] = [];

	constructor(model: SwarmReadModel, opts: WebBoardOptions) {
		this.#model = model;
		for (const [route, [file, type]] of Object.entries(ASSETS)) {
			this.#assets.set(route, { body: new Uint8Array(readFileSync(join(opts.webDir, file))), type });
		}
		this.#roots = canonicalRoots([opts.swarmDir, ...opts.extraRoots]);
		this.#snap = new SnapshotBuilder(model, this.#roots);
	}

	get running(): boolean {
		return !!this.#server;
	}

	get port(): number {
		return this.#port;
	}

	start(port = 0): number {
		if (this.#server) return this.#port;
		this.#server = Bun.serve({ hostname: "127.0.0.1", port, fetch: req => this.#handle(req) });
		this.#port = this.#server.port ?? 0;
		return this.#port;
	}

	stop(): void {
		this.#server?.stop(true);
		this.#server = undefined;
		this.#bootstrap.clear();
		this.#tabs = [];
	}

	/** A fresh single-use bootstrap link (5 minutes). Shown only to the user. */
	link(): string {
		const t = token();
		const now = Date.now();
		for (const [k, exp] of this.#bootstrap) if (exp <= now) this.#bootstrap.delete(k);
		this.#bootstrap.set(t, now + TIMING.bootstrapTokenMs);
		return `http://127.0.0.1:${this.#port}/#token=${t}`;
	}

	#headers(type: string, api: boolean): Headers {
		const h = new Headers({
			"Content-Type": type,
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			"Cross-Origin-Resource-Policy": "same-origin",
		});
		if (api) h.set("Cache-Control", "no-store");
		if (type.startsWith("text/html")) h.set("Content-Security-Policy", HTML_CSP);
		return h;
	}

	#refuse(status: number): Response {
		return new Response(REFUSED, { status, headers: this.#headers("text/plain; charset=utf-8", true) });
	}

	#json(body: unknown): Response {
		return new Response(JSON.stringify(body), { headers: this.#headers("application/json; charset=utf-8", true) });
	}

	#bearer(req: Request): string {
		const a = req.headers.get("authorization") ?? "";
		return a.startsWith("Bearer ") ? a.slice(7).trim() : "";
	}

	#tabAuthorized(req: Request): boolean {
		const t = this.#bearer(req);
		return !!t && this.#tabs.some(x => sameToken(x, t));
	}

	#handle(req: Request): Response {
		const url = new URL(req.url);
		const host = `127.0.0.1:${this.#port}`;
		if (req.headers.get("host") !== host) return this.#refuse(421);
		const origin = req.headers.get("origin");
		if (origin !== null && origin !== `http://${host}`) return this.#refuse(403);
		const path = url.pathname;
		if (req.method === "POST" && path === "/api/session") return this.#session(req);
		if (req.method !== "GET") return this.#refuse(405);
		const asset = this.#assets.get(path);
		if (asset) return new Response(asset.body, { headers: this.#headers(asset.type, false) });
		if (!path.startsWith("/api/")) return this.#refuse(404);
		if (!this.#tabAuthorized(req)) return this.#refuse(401);
		switch (path) {
			case "/api/swarm":
				return this.#swarm(url);
			case "/api/frame":
				return this.#frame(url);
			case "/api/transcript":
				return this.#transcript(url);
			case "/api/file":
				return this.#file(url);
			default:
				return this.#refuse(404);
		}
	}

	#session(req: Request): Response {
		const t = this.#bearer(req);
		const now = Date.now();
		let found: string | undefined;
		for (const [k, exp] of this.#bootstrap) {
			if (exp > now && sameToken(k, t)) found = k;
		}
		if (!found) return this.#refuse(401);
		this.#bootstrap.delete(found);
		const tab = token();
		this.#tabs.push(tab);
		while (this.#tabs.length > LIMITS.webTabTokens) this.#tabs.shift();
		return this.#json({ token: tab });
	}

	#swarm(url: URL): Response {
		const sid = this.#model.sid;
		const conv = url.searchParams.get("conversationId");
		if (conv && conv !== sid) return this.#json({ conversationId: conv, swarm: null, member: null });
		const etag = this.#snap.etag();
		if (url.searchParams.get("etag") === etag) return this.#json({ conversationId: sid, swarm: sid, member: "coordinator", unchanged: true, etag });
		return this.#json(this.#snap.build().body);
	}

	#frame(url: URL): Response {
		const target = url.searchParams.get("path") ?? "";
		const snap = this.#snap.build();
		if (!snap.frames.has(target)) return this.#refuse(404);
		const ext = (target.match(/\.[a-z]+$/i)?.[0] ?? "").toLowerCase();
		const type = FRAME_TYPES[ext];
		if (!type) return this.#refuse(404);
		const r = safeRead(target, this.#roots, LIMITS.frameBytes);
		if (!r.ok) return this.#refuse(404);
		const h = this.#headers(type, true);
		return new Response(new Uint8Array(r.buf), { headers: h });
	}

	#transcript(url: URL): Response {
		const name = url.searchParams.get("member") ?? "";
		const src = this.#model.members().some(m => m.name === name) ? this.#model.transcript(name) : undefined;
		if (!src) return this.#refuse(404);
		const limit = Number(url.searchParams.get("limit") ?? "200");
		const page = src.page({
			before: url.searchParams.get("before") ?? undefined,
			after: url.searchParams.get("after") ?? undefined,
			limit: Number.isFinite(limit) ? limit : 200,
		});
		const m = this.#model.members().find(x => x.name === name);
		return this.#json({ member: name, model: m?.model ?? "", effort: m?.effort ?? "", state: m?.state ?? "", role: m?.role ?? "", ...page });
	}

	#file(url: URL): Response {
		const target = url.searchParams.get("path") ?? "";
		const snap = this.#snap.build();
		if (!Object.hasOwn(snap.allowedFiles, target)) return this.#refuse(404);
		const r = safeRead(target, this.#roots, LIMITS.webFileBytes);
		if (!r.ok) return this.#refuse(404);
		return new Response(new Uint8Array(r.buf), { headers: this.#headers("text/plain; charset=utf-8", true) });
	}
}
