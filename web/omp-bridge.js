/*
 * omp-agy-swarm bridge (runs after the vendored app.js / hive.js):
 * - images: every <img> whose src points at /api/frame (inserted, or an existing <img> whose src
 *   changes, as the progress reel does when stepping) is fetched through window.sidecar.fetch and
 *   swapped for a blob: URL; a newer src discards a stale fetch; blobs are revoked when replaced
 *   or when the image leaves the DOM. No credential is ever placed in a URL.
 * - a read-only transcript drawer (window.sidecar.ui.toggleConversation) paging /api/transcript,
 *   and a file drawer for allowedFiles (toggleAuxPane). Everything is rendered with textContent.
 * - a theme toggle and a "Narrator's page" link when the vendored toggle is hidden.
 */
(() => {
	"use strict";
	const sidecar = window.sidecar;
	if (!sidecar) return;
	const $ = id => document.getElementById(id);
	const PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
	const gens = new WeakMap();
	const blobs = new WeakMap();
	// A snapshot that arrived before this script loaded is only retained by the preload (its
	// event fired with no listener, and later polls are `unchanged`).
	let snap = typeof sidecar.snapshot === "function" ? sidecar.snapshot() : null;

	// ---------- images ----------
	function framePath(img) {
		const raw = img.getAttribute("src") || "";
		if (raw.startsWith("blob:") || raw.startsWith("data:")) return "";
		try {
			const u = new URL(raw, location.origin);
			return u.origin === location.origin && u.pathname === "/api/frame" ? u.pathname + u.search : "";
		} catch {
			return "";
		}
	}
	function revoke(img) {
		const old = blobs.get(img);
		if (old) {
			URL.revokeObjectURL(old);
			blobs.delete(img);
		}
	}
	function swap(img) {
		const path = framePath(img);
		if (!path) return;
		const gen = (gens.get(img) || 0) + 1;
		gens.set(img, gen);
		img.setAttribute("src", PLACEHOLDER);
		sidecar
			.fetch(path)
			.then(r => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
			.then(b => {
				const url = URL.createObjectURL(b);
				if (gens.get(img) !== gen || !img.isConnected) {
					URL.revokeObjectURL(url); // a newer src (or removal) won: discard the stale result
					return;
				}
				revoke(img);
				blobs.set(img, url);
				img.setAttribute("src", url);
			})
			.catch(() => {
				if (gens.get(img) === gen) img.setAttribute("alt", img.getAttribute("alt") || "image unavailable");
			});
	}
	function scan(node) {
		if (node.nodeType !== 1) return;
		if (node.tagName === "IMG") swap(node);
		for (const img of node.querySelectorAll ? node.querySelectorAll("img") : []) swap(img);
	}
	function dropped(node) {
		if (node.nodeType !== 1) return;
		const imgs = node.tagName === "IMG" ? [node] : node.querySelectorAll ? [...node.querySelectorAll("img")] : [];
		for (const img of imgs) {
			if (!img.isConnected) {
				gens.set(img, (gens.get(img) || 0) + 1);
				revoke(img);
			}
		}
	}
	new MutationObserver(records => {
		for (const r of records) {
			if (r.type === "attributes" && r.target.tagName === "IMG") swap(r.target);
			else if (r.type === "childList") {
				for (const n of r.addedNodes) scan(n);
				for (const n of r.removedNodes) dropped(n);
			}
		}
	}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
	scan(document.body);

	// ---------- drawer ----------
	const drawer = $("omp-drawer");
	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}
	// Every open or close starts a new drawer generation; a fetch that resolves for an older one is
	// discarded (reopening the same member must not receive the previous drawer's pages).
	let drawerGen = 0;
	function closeDrawer() {
		drawerGen++;
		drawer.hidden = true;
		drawer.replaceChildren();
		drawer.dataset.member = "";
	}
	function drawerHead(title, sub) {
		const head = el("div", "omp-drawer-head");
		const t = el("div", "omp-drawer-title", title);
		const s = el("div", "omp-drawer-sub", sub || "");
		const x = el("button", "omp-drawer-close", "✕");
		x.type = "button";
		x.setAttribute("aria-label", "Close");
		x.onclick = closeDrawer;
		head.append(t, s, x);
		return head;
	}

	async function openTranscript(member) {
		const gen = ++drawerGen;
		const m = (snap && Array.isArray(snap.members) ? snap.members : []).find(x => x.name === member);
		drawer.replaceChildren();
		drawer.dataset.member = member;
		drawer.hidden = false;
		const sub = m ? `${m.model || ""} · ${m.status || ""}` : "";
		drawer.append(drawerHead(member, sub));
		if (m && m.role === "coordinator") {
			drawer.append(
				el(
					"div",
					"omp-banner",
					"Read-only. To talk to the coordinator, type in your omp terminal (paste feedback into the omp coordinator input).",
				),
			);
		}
		const older = el("button", "omp-page-btn", "Load older");
		older.type = "button";
		const list = el("div", "omp-items");
		const newer = el("button", "omp-page-btn", "Load newer");
		newer.type = "button";
		drawer.append(older, list, newer);
		let first = "";
		let last = "";
		let epoch = "";
		const render = it => {
			const row = el("div", `omp-item omp-${it.kind}`);
			const label = it.kind === "tool_call" ? `→ ${it.tool || ""}` : it.kind === "tool_result" ? `← ${it.tool || ""}${it.ok === false ? " error" : ""}` : it.kind;
			row.append(el("div", "omp-item-kind", label), el("pre", "omp-item-text", it.text));
			return row;
		};
		const load = async q => {
			const res = await sidecar.fetch(`/api/transcript?member=${encodeURIComponent(member)}&limit=200${q}`);
			if (!res.ok) throw new Error(String(res.status));
			return res.json();
		};
		const apply = (p, where) => {
			if (gen !== drawerGen || drawer.dataset.member !== member) return;
			if (epoch && p.epoch !== epoch) {
				list.replaceChildren();
				where = "replace";
			}
			epoch = p.epoch;
			const rows = p.items.map(render);
			if (where === "before") list.prepend(...rows);
			else if (where === "after") list.append(...rows);
			else list.replaceChildren(...rows);
			if (where !== "after" && p.first) first = p.first;
			if (where !== "before" && p.last) last = p.last;
			if (where === "replace") {
				first = p.first || "";
				last = p.last || "";
			}
			// Each direction's button follows only the page that answered for that direction.
			if (where !== "after") older.hidden = !p.more_before;
			if (where !== "before") newer.hidden = !p.more_after;
		};
		older.onclick = async () => {
			try {
				apply(await load(`&before=${encodeURIComponent(first)}`), "before");
			} catch {}
		};
		newer.onclick = async () => {
			try {
				apply(await load(`&after=${encodeURIComponent(last)}`), "after");
			} catch {}
		};
		try {
			apply(await load(""), "replace");
			list.scrollTop = list.scrollHeight;
		} catch {
			if (gen === drawerGen) list.append(el("div", "omp-banner", "The transcript is not available."));
		}
	}

	async function openFile(uri) {
		if (typeof uri !== "string" || !uri.startsWith("/api/file?")) return;
		const gen = ++drawerGen;
		const path = new URL(uri, location.origin).searchParams.get("path") || "";
		drawer.replaceChildren(drawerHead(path.split("/").pop() || "file", path));
		drawer.hidden = false;
		drawer.dataset.member = "";
		try {
			const res = await sidecar.fetch(uri);
			if (!res.ok) throw new Error(String(res.status));
			const text = await res.text();
			if (gen === drawerGen) drawer.append(el("pre", "omp-file", text));
		} catch {
			if (gen === drawerGen) drawer.append(el("div", "omp-banner", "The file is not available."));
		}
	}

	window.addEventListener("omp:conversation", e => {
		const id = e.detail;
		const m = (snap && Array.isArray(snap.members) ? snap.members : []).find(x => x.conversation_id === id);
		if (!m) return;
		if (!drawer.hidden && drawer.dataset.member === m.name) closeDrawer();
		else openTranscript(m.name);
	});
	window.addEventListener("omp:aux", e => openFile(e.detail && e.detail.uri));
	document.addEventListener("keydown", e => {
		if (e.key === "Escape" && !drawer.hidden) closeDrawer();
	});

	// ---------- theme toggle ----------
	$("omp-theme-toggle").onclick = () => {
		const dark = document.documentElement.dataset.theme === "dark";
		const next = dark ? "light" : "dark";
		try {
			localStorage.setItem("swarm.theme", next);
		} catch {}
		sidecar.theme.apply(next);
	};

	// ---------- narrator page link ----------
	let link = null;
	function syncNarratorLink() {
		const mode = $("ov-mode");
		const want = !!(snap && snap.view && snap.view.html) && !!mode && mode.classList.contains("hidden");
		if (want && !link) {
			link = el("button", "omp-narrator-link ghost-btn sm", "Narrator’s page");
			link.type = "button";
			link.dataset.testid = "omp-narrator-link";
			link.onclick = () => $("ov-mode").click();
			// Next to the Overview tab label (the vendored toggle's row is hidden in the plain view).
			const tab = $("tabbtn-overview");
			if (tab) tab.after(link);
			else mode.before(link);
		} else if (!want && link) {
			link.remove();
			link = null;
		}
	}
	window.addEventListener("omp:snapshot", e => {
		snap = e.detail;
		setTimeout(syncNarratorLink, 0);
	});
	if (snap) setTimeout(syncNarratorLink, 0);
	// Only the vendored mode toggle's class decides whether the link shows.
	const modeToggle = $("ov-mode");
	if (modeToggle) new MutationObserver(() => syncNarratorLink()).observe(modeToggle, { attributes: true, attributeFilter: ["class"] });
})();
