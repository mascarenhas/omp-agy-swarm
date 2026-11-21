// Browser tests for the opt-in web board (§12.4, SW-08, SW-12) with playwright-core and an
// installed Chrome/Chromium. Skipped with a loud message when none is found.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { RuntimeReadModel } from "../../src/runtime/read-model.ts";
import { WebBoard } from "../../src/ui/web/server.ts";
import { fastTimers, Harness, REPO, until } from "../helpers/harness.ts";

const CANDIDATES = [
	process.env.CHROME_PATH,
	`${process.env.HOME}/.local/bin/google-chrome`,
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
].filter((p): p is string => !!p);
const CHROME = CANDIDATES.find(p => existsSync(p));
if (!CHROME) console.warn("\n*** web-browser tests SKIPPED: no Chrome/Chromium found (set CHROME_PATH) ***\n");

// A 1×1 PNG (two colours so the two frames differ).
const png = (r: number) =>
	Buffer.from(
		`89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763${r.toString(16).padStart(2, "0")}f8ff3f0005fe02fe0dcbcf4b0000000049454e44ae426082`,
		"hex",
	);

describe.skipIf(!CHROME)("web board in a browser", () => {
	let h: Harness;
	let board: WebBoard;
	let browser: Browser;
	let page: Page;
	const frameRequests: { auth: boolean; status: number }[] = [];

	beforeAll(async () => {
		fastTimers();
		h = new Harness({ mode: "tui" });
		const shots = join(h.dir, "shots");
		mkdirSync(shots, { recursive: true });
		writeFileSync(join(shots, "one.png"), png(0x10));
		writeFileSync(join(shots, "two.png"), png(0xe0));
		h.factory.brains.set("ui", async t => {
			await t.call("post_message", { text: `@coordinator baseline\nScreenshot: ${join(shots, "one.png")} | before` });
			await t.call("post_message", { text: `@coordinator [done] fixed\nScreenshot: ${join(shots, "two.png")} | after` });
			await t.call("swarm_wait", {});
		});
		await h.swarm({ action: "title", title: "browser fixture" });
		await h.swarm({ action: "add", name: "ui", brief: "make the change" });
		await until(() => h.member("ui").phase === "parked", 2000, "parked");
		board = new WebBoard(new RuntimeReadModel(h.rt), { webDir: join(REPO, "web"), swarmDir: h.dir, extraRoots: [] });
		board.start(0);
		browser = await chromium.launch({ executablePath: CHROME, headless: true });
		page = await browser.newPage();
		page.on("response", r => {
			if (new URL(r.url()).pathname === "/api/frame") frameRequests.push({ auth: !!r.request().headers().authorization, status: r.status() });
		});
		await page.route("**/app.js", async route => {
			const res = await route.fetch();
			const body = await res.text();
			// Records what app.js sees as the URL fragment when it starts.
			await route.fulfill({ response: res, body: `window.__hashAtApp = location.hash;\n${body}` });
		});
		await page.goto(board.link());
		await page.waitForSelector("#board:not(.hidden)", { timeout: 15_000 });
	});

	afterAll(async () => {
		await browser?.close();
		board?.stop();
		await h?.close();
	});

	test("the fragment is gone before app.js runs and never reaches the server", async () => {
		expect(await page.evaluate(() => (window as unknown as { __hashAtApp: string }).__hashAtApp)).toBe("");
		expect(await page.evaluate(() => location.hash)).toBe("");
		expect(await page.evaluate(() => document.cookie)).toBe("");
	});

	test("all five tabs render from the runtime", async () => {
		for (const tab of ["overview", "feed", "members", "graph", "raw"]) {
			await page.click(`[data-tab="${tab}"]`);
			await page.waitForFunction(t => document.getElementById(`tab-${t}`)?.classList.contains("active"), tab);
		}
		await page.click('[data-tab="feed"]');
		await page.waitForFunction(() => (document.getElementById("feed")?.textContent ?? "").includes("fixed"));
		await page.click('[data-tab="members"]');
		await page.waitForFunction(() => (document.getElementById("members")?.textContent ?? "").includes("ui"));
	});

	test("reel images load through blob URLs, including after stepping the reel (src changes)", async () => {
		await page.click('[data-tab="overview"]');
		await page.waitForFunction(() => {
			const img = document.querySelector<HTMLImageElement>(".o2-reel img.o2-rimg");
			return !!img && img.getAttribute("src")?.startsWith("blob:");
		}, undefined, { timeout: 10_000 });
		const first = await page.evaluate(() => document.querySelector<HTMLImageElement>(".o2-reel img.o2-rimg")?.getAttribute("src"));
		await page.evaluate(() => {
			const s = document.querySelector<HTMLInputElement>(".o2-reel .o2-rscrub");
			if (!s) throw new Error("no scrub control");
			s.value = "0";
			s.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await page.waitForFunction(
			prev => {
				const src = document.querySelector<HTMLImageElement>(".o2-reel img.o2-rimg")?.getAttribute("src") ?? "";
				return src.startsWith("blob:") && src !== prev;
			},
			first,
			{ timeout: 10_000 },
		);
		expect(frameRequests.filter(r => r.status === 200).every(r => r.auth)).toBe(true);
		expect(frameRequests.some(r => r.status === 200)).toBe(true);
	});

	test("the transcript drawer pages through /api/transcript", async () => {
		const conv = h.member("ui").conversationId;
		await page.evaluate(id => window.sidecar.ui.toggleConversation(id), conv);
		await page.waitForSelector("#omp-drawer:not([hidden]) .omp-item");
		const text = await page.textContent("#omp-drawer");
		expect(text).toContain("make the change");
		await page.keyboard.press("Escape");
		await page.waitForSelector("#omp-drawer[hidden]", { state: "attached" });
	});

	test("a snapshot that arrives before omp-bridge.js loads is not lost (the drawer still opens)", async () => {
		const late = await browser.newPage();
		try {
			const firstSwarm = Promise.withResolvers<void>();
			late.on("requestfinished", r => {
				if (new URL(r.url()).pathname === "/api/swarm") firstSwarm.resolve();
			});
			// The bridge loads only after the first full snapshot was fetched and announced, so its
			// omp:snapshot event fired with no listener; later polls only answer `unchanged`.
			await late.route("**/omp-bridge.js", async route => {
				await firstSwarm.promise;
				await Bun.sleep(300);
				await route.continue();
			});
			await late.goto(board.link());
			await late.waitForSelector("#board:not(.hidden)", { timeout: 15_000 });
			await late.waitForFunction(() => document.getElementById("omp-theme-toggle")?.onclick != null, undefined, { timeout: 10_000 });
			const conv = h.member("ui").conversationId;
			await late.evaluate(id => window.sidecar.ui.toggleConversation(id), conv);
			await late.waitForSelector("#omp-drawer:not([hidden]) .omp-item", { timeout: 10_000 });
			expect(await late.textContent("#omp-drawer")).toContain("make the change");
		} finally {
			await late.close();
		}
	}, 30_000);

	test("the narrator page link appears only with view.html", async () => {
		expect(await page.$(".omp-narrator-link")).toBeNull();
		writeFileSync(join(h.dir, "view.json"), JSON.stringify({ version: 1, as_of_seq: 1, headline: "h" }));
		writeFileSync(join(h.dir, "view.html"), "<p>narrated</p>");
		h.rt.changed();
		// The page polls /api/swarm every 1.5 s; the link follows the next snapshot.
		await page.waitForSelector(".omp-narrator-link", { timeout: 10_000 });
		await page.click(".omp-narrator-link");
		// The vendored code now shows the narrator's page (or its watchdog fallback) and its own
		// toggle back to the Overview; the bridge link steps aside.
		await page.waitForSelector("#ov-mode:not(.hidden)", { timeout: 10_000 });
		await page.waitForSelector(".omp-narrator-link", { state: "detached", timeout: 10_000 });
	}, 20_000);

	test("a reload shows the new-link notice; a stopped board serves nothing", async () => {
		await page.reload();
		await page.waitForSelector("#omp-notice:not([hidden])");
		expect(await page.textContent("#omp-notice")).toContain("Run /swarm-ui again");
		const port = board.port;
		board.stop();
		const ok = await page.evaluate(async p => {
			try {
				await fetch(`http://127.0.0.1:${p}/`);
				return true;
			} catch {
				return false;
			}
		}, port);
		expect(ok).toBe(false);
	});
});

declare global {
	interface Window {
		sidecar: { ui: { toggleConversation(id: string): void } };
	}
}
