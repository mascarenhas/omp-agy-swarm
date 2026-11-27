// Browser tests for the opt-in web board (§12.4, SW-08, SW-12) with playwright-core and an
// installed Chrome/Chromium. Skipped with a loud message when none is found.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
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
		try {
			browser = await chromium.launch({
				executablePath: CHROME,
				headless: true,
				chromiumSandbox: process.env.CHROME_CI_SANDBOX === "1",
				timeout: 30_000,
			});
		} catch (error) {
			// Playwright's launch error includes the command and browser stderr.
			throw new Error(`Headless Chrome failed to launch (${CHROME}): ${error}`, { cause: error });
		}
		try {
			page = await browser.newPage();
			await page.goto(url, { timeout: 15_000 });
			await page.waitForSelector("#board:not(.hidden)", { timeout: 15_000 });
		} catch (error) {
			throw new Error(`Chrome launched but the web board did not become ready (${url}): ${error}`, { cause: error });
		}
	}, 75_000);

	afterAll(async () => {
		try {
			await browser?.close();
		} finally {
			board?.stop();
			await h?.close();
		}
	}, 30_000);

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

	test("progress carousel supports screenshots and coordinator markdown without Compare with now", async () => {
		await h.post("Progress: **Phase 1** status\n- **ui**: landed baseline & fix\n- Safe check: `<script>window.__xss=1</script>` & <img src=x onerror=\"window.__xss=2\">");
		await page.click('[data-tab="overview"]');
		// Wait for the coordinator's markdown update to arrive via polling and render as latest frame.
		await page.waitForSelector('.o2-reel.omp-reel [data-testid="swarm-reel-markdown"]', { timeout: 10_000 });
		// "Compare with now" and its swipe controls must be absent.
		expect(await page.locator(".o2-reel .o2-rcmp, .o2-reel .o2-rswipe, .o2-reel .o2-rline, .o2-reel .o2-rnow").count()).toBe(0);
		expect(await page.locator(".o2-reel").textContent()).not.toContain("Compare with now");
		// Markdown renders structurally and never executes injected HTML.
		const md = page.locator('[data-testid="swarm-reel-markdown"]');
		expect(await md.locator("li strong").first().textContent()).toBe("ui");
		expect(await md.locator("code").first().textContent()).toBe("<script>window.__xss=1</script>");
		expect(await md.locator("img, script").count()).toBe(0);
		expect(await page.evaluate(() => Reflect.get(window, "__xss"))).toBeUndefined();
		expect(await page.locator(".o2-reel .o2-rmeta").textContent()).toContain("@coordinator");
		// Scrub back through both screenshot frames and verify both decode from same-origin /api/frame.
		await page.evaluate(() => {
			const s = document.querySelector<HTMLInputElement>(".o2-reel .o2-rscrub");
			if (!s) throw new Error("no scrub control");
			s.value = "1";
			s.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const image = page.locator(".o2-reel img.o2-rimg");
		await image.waitFor({ timeout: 10_000 });
		await image.evaluate(async img => (img as HTMLImageElement).decode());
		const secondSrc = await image.getAttribute("src");
		expect(secondSrc).toMatch(/^\/api\/frame\?/);
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
			secondSrc,
			{ timeout: 10_000 },
		);
		await image.evaluate(async img => (img as HTMLImageElement).decode());
		// Open the full timeline modal and step forward to the markdown frame.
		await page.click(".o2-reel .o2-rexp");
		await page.waitForSelector(".o2-tv");
		await page.keyboard.press("End");
		await page.waitForSelector(".o2-tv .omp-tv-md");
		expect(await page.locator(".o2-tv .omp-tv-md").textContent()).toContain("landed baseline & fix");
		await page.keyboard.press("Escape");
		await page.waitForSelector(".o2-tv", { state: "detached" });
	});

	test("progress carousel preserves selection, scroll, and modal sync across polls and invalid narrator frames", async () => {
		// Post a long markdown progress update so the stage scrolls, then post a newer one to make it non-latest.
		const longBody = Array.from({ length: 24 }, (_, i) => `- item ${i + 1}: detail line for scroll stability`).join("\n");
		await h.post(`Progress: Long scrollable update\n${longBody}`);
		await h.post("Progress: Latest update after scroll target\n- fresh item");
		// Wait for the latest frame to appear in the carousel.
		await page.waitForFunction(
			() => (document.querySelector(".o2-reel .o2-rcap")?.textContent ?? "").includes("Latest update after scroll target"),
			undefined,
			{ timeout: 10_000 },
		);
		// Step back one frame onto the long scrollable update, scroll down, and focus the previous button.
		await page.click(".o2-reel .omp-rnav.prev");
		await page.waitForFunction(
			() => (document.querySelector(".o2-reel .o2-rcap")?.textContent ?? "").includes("Long scrollable update"),
			undefined,
			{ timeout: 10_000 },
		);
		const scrolled = await page.evaluate(() => {
			const st = document.querySelector<HTMLElement>(".o2-reel .o2-rstage");
			if (!st) return 0;
			st.scrollTop = 90;
			st.dispatchEvent(new Event("scroll"));
			return st.scrollTop;
		});
		expect(scrolled).toBeGreaterThan(0);
		try {
			// Write invalid narrator reel.frames (blank markdown with image path + non-image file path);
			// bridge must fall back to board frames while preserving selection and scroll.
			writeFileSync(
				join(h.dir, "view.json"),
				JSON.stringify({
					version: 1,
					as_of_seq: h.rt.board.head,
					headline: "poll update",
					reel: {
						frames: [
							{ kind: "markdown", markdown: "  ", path: join(h.dir, "shots", "a.png"), caption: "invalid" },
							{ kind: "image", path: join(h.dir, "notes.txt"), caption: "non-image" },
						],
					},
				}),
			);
			await h.post("unrelated chatter to force snapshot poll");
			await page.waitForFunction(
				() => (document.querySelector("#ov-plain .o2")?.textContent ?? "").includes("poll update"),
				undefined,
				{ timeout: 10_000 },
			);
			expect(await page.locator(".o2-reel .o2-rcap").textContent()).toContain("Long scrollable update");
			const scrollAfterPoll = await page.evaluate(() => document.querySelector<HTMLElement>(".o2-reel .o2-rstage")?.scrollTop ?? 0);
			expect(scrollAfterPoll).toBeGreaterThan(0);
			// Open modal, step to latest, then post a new progress frame while the modal stays open.
			await page.click(".o2-reel .o2-rexp");
			await page.waitForSelector(".o2-tv");
			await page.keyboard.press("End");
			await page.waitForFunction(
				() => (document.querySelector(".o2-tv .o2-tvcap")?.textContent ?? "").includes("Latest update after scroll target"),
				undefined,
				{ timeout: 10_000 },
			);
			await h.post("Progress: Live update while modal open\n- pushed live");
			await page.waitForFunction(
				() => (document.querySelector(".o2-tv .o2-tvcap")?.textContent ?? "").includes("Live update while modal open"),
				undefined,
				{ timeout: 10_000 },
			);
			// Step back inside the modal and close; the underlying card must stay synced to that frame.
			await page.keyboard.press("ArrowLeft");
			await page.waitForFunction(
				() => (document.querySelector(".o2-tv .o2-tvcap")?.textContent ?? "").includes("Latest update after scroll target"),
				undefined,
				{ timeout: 10_000 },
			);
			await page.keyboard.press("Escape");
			await page.waitForSelector(".o2-tv", { state: "detached" });
			expect(await page.locator(".o2-reel .o2-rcap").textContent()).toContain("Latest update after scroll target");
			// Single-frame narrator reel hides prev/next buttons and re-renders when a later paragraph changes.
			const prefix = "Same opening paragraph that spans well beyond sixty four characters without changing.";
			writeFileSync(
				join(h.dir, "view.json"),
				JSON.stringify({
					version: 1,
					as_of_seq: h.rt.board.head,
					headline: "single frame v1",
					reel: { frames: [{ kind: "markdown", seq: 1, caption: "Edited note", markdown: `${prefix}\n\nOriginal tail` }] },
				}),
			);
			h.rt.changed();
			await page.waitForFunction(
				() => (document.querySelector('[data-testid="swarm-reel-markdown"]')?.textContent ?? "").includes("Original tail"),
				undefined,
				{ timeout: 10_000 },
			);
			expect(await page.locator(".o2-reel .omp-rnav.prev").isVisible()).toBe(false);
			expect(await page.locator(".o2-reel .omp-rnav.next").isVisible()).toBe(false);
			writeFileSync(
				join(h.dir, "view.json"),
				JSON.stringify({
					version: 1,
					as_of_seq: h.rt.board.head,
					headline: "single frame v2",
					reel: {
						frames: [
							{ kind: "markdown", seq: 1, caption: "Renamed caption", markdown: `${prefix}\n\nUpdated tail` },
							{ kind: "markdown", seq: 2, caption: "Second frame", markdown: "newer frame" },
						],
					},
				}),
			);
			h.rt.changed();
			await page.waitForFunction(
				() => (document.querySelector('[data-testid="swarm-reel-markdown"]')?.textContent ?? "").includes("newer frame"),
				undefined,
				{ timeout: 10_000 },
			);
			// Selecting frame 1 by seq survives a caption rename + tail edit without jumping to latest.
			await page.click(".o2-reel .omp-rnav.prev");
			await page.waitForFunction(
				() =>
					(document.querySelector(".o2-reel .o2-rcap")?.textContent ?? "").includes("Renamed caption") &&
					(document.querySelector('[data-testid="swarm-reel-markdown"]')?.textContent ?? "").includes("Updated tail"),
				undefined,
				{ timeout: 10_000 },
			);
			writeFileSync(
				join(h.dir, "view.json"),
				JSON.stringify({
					version: 1,
					as_of_seq: h.rt.board.head,
					headline: "caption edit v3",
					reel: {
						frames: [
							{ kind: "markdown", seq: 1, caption: "Corrected caption", markdown: `${prefix}\n\nUpdated tail v3` },
							{ kind: "markdown", seq: 2, caption: "Second frame", markdown: "newer frame" },
						],
					},
				}),
			);
			h.rt.changed();
			await page.waitForFunction(
				() =>
					(document.querySelector(".o2-reel .o2-rcap")?.textContent ?? "").includes("Corrected caption") &&
					(document.querySelector('[data-testid="swarm-reel-markdown"]')?.textContent ?? "").includes("Updated tail v3"),
				undefined,
				{ timeout: 10_000 },
			);
		} finally {
			if (existsSync(join(h.dir, "view.json"))) unlinkSync(join(h.dir, "view.json"));
			h.rt.changed();
		}
	}, 30_000);

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
