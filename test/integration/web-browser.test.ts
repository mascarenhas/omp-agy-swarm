// Browser tests for the opt-in web board (§12.4, SW-08, SW-12) with playwright-core and an
// installed Chrome/Chromium. Skipped with a loud message when none is found.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

// Two valid 1×1 RGB PNGs, with different pixel colours.
const PNGS = [
	"89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c631060600000003400113f680e740000000049454e44ae426082",
	"89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c6378c0c0000002a400e1df929b4d0000000049454e44ae426082",
] as const;

describe.skipIf(!CHROME)("web board in a browser", () => {
	let h: Harness;
	let board: WebBoard;
	let browser: Browser;
	let page: Page;
	let url: string;

	beforeAll(async () => {
		fastTimers();
		h = new Harness({ mode: "tui" });
		const shots = join(h.dir, "shots");
		mkdirSync(shots, { recursive: true });
		writeFileSync(join(shots, "one.png"), Buffer.from(PNGS[0], "hex"));
		writeFileSync(join(shots, "two.png"), Buffer.from(PNGS[1], "hex"));
		h.factory.brains.set("ui", async t => {
			await t.call("post_message", { text: `@coordinator baseline\nScreenshot: ${join(shots, "one.png")} | before` });
			await t.call("post_message", { text: `@coordinator [done] fixed\nScreenshot: ${join(shots, "two.png")} | after` });
			await t.call("swarm_wait", {});
		});
		await h.swarm({ action: "title", title: "browser fixture" });
		await h.swarm({ action: "add", name: "ui", brief: "make the change" });
		await until(() => h.member("ui").phase === "parked", 2000, "parked");
		board = new WebBoard(new RuntimeReadModel(h.rt), { webDir: join(REPO, "web"), swarmDir: h.dir, extraRoots: [] });
		url = `http://127.0.0.1:${board.start()}/`;
		browser = await chromium.launch({ executablePath: CHROME, headless: true });
		page = await browser.newPage();
		await page.goto(url);
		await page.waitForSelector("#board:not(.hidden)", { timeout: 15_000 });
	});

	afterAll(async () => {
		await browser?.close();
		board?.stop();
		await h?.close();
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

	test("both reel images decode from same-origin /api/frame as the reel is scrubbed", async () => {
		await page.click('[data-tab="overview"]');
		const image = page.locator(".o2-reel img.o2-rimg");
		await image.evaluate(async img => (img as HTMLImageElement).decode());
		const first = await image.getAttribute("src");
		expect(first).toMatch(/^\/api\/frame\?/);
		await page.evaluate(() => {
			const s = document.querySelector<HTMLInputElement>(".o2-reel .o2-rscrub");
			if (!s) throw new Error("no scrub control");
			s.value = "0";
			s.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await page.waitForFunction(
			prev => {
				const src = document.querySelector<HTMLImageElement>(".o2-reel img.o2-rimg")?.getAttribute("src") ?? "";
				return src.startsWith("/api/frame?") && src !== prev;
			},
			first,
			{ timeout: 10_000 },
		);
		await image.evaluate(async img => (img as HTMLImageElement).decode());
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

	test("the transcript drawer replaces its items on a same-epoch cursor reset", async () => {
		const worker = h.session("ui");
		const original = worker.branchEntries;
		const manager = SessionManager.inMemory(h.binding.cwd);
		const common = manager.appendCustomMessageEntry("probe", "WEB-COMMON-ENTRY", true);
		for (let i = 0; i < 200; i++) manager.appendCustomMessageEntry("probe", `WEB-RETIRED-ENTRY ${i}`, true);
		worker.branchEntries = () => manager.getBranch();
		try {
			await page.evaluate(id => window.sidecar.ui.toggleConversation(id), h.member("ui").conversationId);
			const drawer = page.locator("#omp-drawer:not([hidden])");
			await drawer.getByText("WEB-RETIRED-ENTRY 199", { exact: true }).waitFor();
			manager.branch(common);
			manager.appendCustomMessageEntry("probe", "WEB-REPLACEMENT-ENTRY", true);
			await drawer.getByRole("button", { name: "Load older" }).click();
			await drawer.getByText("WEB-REPLACEMENT-ENTRY", { exact: true }).waitFor();
			expect(await drawer.locator(".omp-item-text").allTextContents()).toEqual(["WEB-COMMON-ENTRY", "WEB-REPLACEMENT-ENTRY"]);
			await page.keyboard.press("Escape");
			await page.waitForSelector("#omp-drawer[hidden]", { state: "attached" });
		} finally {
			worker.branchEntries = original;
		}
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
			await late.goto(url);
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

	test("the plain URL survives reload; a stopped board serves nothing", async () => {
		expect(page.url()).toBe(url);
		await page.reload();
		await page.waitForSelector("#board:not(.hidden)", { timeout: 10_000 });
		await page.click('[data-tab="feed"]');
		await page.waitForFunction(() => (document.getElementById("feed")?.textContent ?? "").includes("fixed"));
		expect(page.url()).toBe(url);
		board.stop();
		const ok = await page.evaluate(async address => {
			try {
				await fetch(address);
				return true;
			} catch {
				return false;
			}
		}, url);
		expect(ok).toBe(false);
	});
});

declare global {
	interface Window {
		sidecar: { ui: { toggleConversation(id: string): void } };
	}
}
