// The opt-in, read-only web board: loopback listener, with Host and Origin checks for
// direct access, SSH port forwarding, and a Tailscale Serve HTTPS reverse proxy.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS } from "../../env.ts";
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

// DNS labels only, with an optional valid TCP port. Bound the full DNS name as well.
const MAGIC_DNS = /^((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net)(?::([1-9][0-9]{0,4}))?$/i;

type Scheme = "http" | "https";
const DEFAULT_PORT = { http: 80, https: 443 } as const;

export function isLoopbackAuthority(authority: string, port: number, scheme: Scheme): boolean {
	const host = authority.toLowerCase();
	const suffix = `:${port}`;
	const name = host.endsWith(suffix) ? host.slice(0, -suffix.length) : port === DEFAULT_PORT[scheme] ? host : "";
	return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

function isMagicDns(host: string): boolean {
	if (host.length > 259) return false; // DNS name + colon + five-digit port
	const match = MAGIC_DNS.exec(host);
	return !!match && match[1]!.length <= 253 && (match[2] === undefined || Number(match[2]) <= 65535);
}

function matchesOrigin(origin: string, scheme: Scheme, host: string): boolean {
	if (/[^\x21-\x7e]/.test(origin)) return false;
	const value = origin.toLowerCase();
	const expected = `${scheme}://${host.toLowerCase()}`;
	if (value === expected) return true;
	// Compare only against legal forms of the validated authority, never trim the input.
	const suffix = `:${DEFAULT_PORT[scheme]}`;
	if (host.endsWith(suffix)) return value === expected.slice(0, -suffix.length);
	const hasPort = host.lastIndexOf(":") > host.lastIndexOf("]");
	return !hasPort && value === `${expected}${suffix}`;
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

	get port(): number | undefined {
		return this.#server?.port;
	}

	start(port = 0): number {
		this.#server ??= Bun.serve({ hostname: "127.0.0.1", port, fetch: req => this.#handle(req) });
		return this.#server.port!; // An IP listener always has a bound port.
	}

	stop(): void {
		this.#server?.stop(true);
		this.#server = undefined;
	}

	link(): string | undefined {
		const port = this.port;
		return port === undefined ? undefined : `http://127.0.0.1:${port}/`;
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
		const headers = this.#headers("text/plain; charset=utf-8", true);
		if (status === 405) headers.set("Allow", "GET");
		return new Response(REFUSED, { status, headers });
	}

	#json(body: unknown): Response {
		return new Response(JSON.stringify(body), { headers: this.#headers("application/json; charset=utf-8", true) });
	}

	#handle(req: Request): Response {
		if (req.method !== "GET") return this.#refuse(405);
		// Tailscale's proxy sets this header for public Funnel traffic, not tailnet Serve.
		if (req.headers.has("tailscale-funnel-request")) return this.#refuse(403);
		const authority = req.headers.get("host") ?? "";
		const port = this.port;
		let scheme: Scheme = req.headers.get("x-forwarded-proto")?.toLowerCase() === "https" ? "https" : "http";
		if (port === undefined || !isLoopbackAuthority(authority, port, scheme)) {
			if (!isMagicDns(authority)) return this.#refuse(421);
			scheme = "https";
		}
		const origin = req.headers.get("origin");
		if (origin !== null && !matchesOrigin(origin, scheme, authority)) return this.#refuse(403);
		const url = new URL(req.url);
		const path = url.pathname;
		const asset = this.#assets.get(path);
		if (asset) return new Response(asset.body, { headers: this.#headers(asset.type, false) });
		if (!path.startsWith("/api/")) return this.#refuse(404);
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
