/*
 * omp-agy-swarm bridge (runs after the vendored app.js / hive.js):
 * - a read-only transcript drawer (window.sidecar.ui.toggleConversation) paging /api/transcript,
 *   and a file drawer for allowedFiles (toggleAuxPane). Everything is rendered with textContent.
 * - a theme toggle, a "Narrator's page" link when the vendored toggle is hidden,
 *   and the enhanced Progress carousel (markdown updates + screenshots, without Compare with now).
 */
(() => {
	"use strict";
	const sidecar = window.sidecar;
	if (!sidecar) return;
	const $ = id => document.getElementById(id);
	// A snapshot that arrived before this script loaded is only retained by the preload (its
	// event fired with no listener, and later polls are `unchanged`).
	let snap = typeof sidecar.snapshot === "function" ? sidecar.snapshot() : null;

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
			if (p.cursor_reset || (epoch && p.epoch !== epoch)) {
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
	// ---------- progress carousel (markdown + screenshots, no Compare with now) ----------
	const SVG_NS = "http://www.w3.org/2000/svg";
	let reelSwarmId = null;
	let reelSelectedKey = null;
	let mountedReel = null;
	let activeModal = null;
	let ovObserver = null;
	function expandIcon() {
		const svg = document.createElementNS(SVG_NS, "svg");
		svg.setAttribute("viewBox", "0 0 16 16");
		svg.setAttribute("width", "13");
		svg.setAttribute("height", "13");
		svg.setAttribute("aria-hidden", "true");
		const path = document.createElementNS(SVG_NS, "path");
		path.setAttribute("d", "M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9");
		path.setAttribute("fill", "none");
		path.setAttribute("stroke", "currentColor");
		path.setAttribute("stroke-width", "1.5");
		path.setAttribute("stroke-linecap", "round");
		path.setAttribute("stroke-linejoin", "round");
		svg.append(path);
		return svg;
	}

	function appendInline(parent, text) {
		const s = String(text || "");
		let i = 0;
		let buf = "";
		const flush = () => {
			if (buf) {
				parent.append(document.createTextNode(buf));
				buf = "";
			}
		};
		while (i < s.length) {
			if (s[i] === "`") {
				const end = s.indexOf("`", i + 1);
				if (end > i + 1) {
					flush();
					parent.append(el("code", "", s.slice(i + 1, end)));
					i = end + 1;
					continue;
				}
			}
			if (s[i] === "*" && s[i + 1] === "*") {
				const end = s.indexOf("**", i + 2);
				if (end > i + 2) {
					flush();
					const strong = document.createElement("strong");
					appendInline(strong, s.slice(i + 2, end));
					parent.append(strong);
					i = end + 2;
					continue;
				}
			}
			if (s[i] === "~" && s[i + 1] === "~") {
				const end = s.indexOf("~~", i + 2);
				if (end > i + 2) {
					flush();
					const del = document.createElement("del");
					appendInline(del, s.slice(i + 2, end));
					parent.append(del);
					i = end + 2;
					continue;
				}
			}
			if (s[i] === "*" && s[i + 1] !== "*" && s[i + 1] !== " " && s[i + 1] !== undefined) {
				let end = i + 1;
				while (end < s.length) {
					end = s.indexOf("*", end);
					if (end < 0) break;
					if (s[end - 1] !== " " && s[end + 1] !== "*" && s[end - 1] !== "*") break;
					end++;
				}
				if (end > i + 1) {
					flush();
					const em = document.createElement("em");
					appendInline(em, s.slice(i + 1, end));
					parent.append(em);
					i = end + 1;
					continue;
				}
			}
			buf += s[i++];
		}
		flush();
	}

	function parseTableRow(line) {
		const trimmed = line.trim();
		if (!trimmed.includes("|")) return null;
		const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "");
		const cells = stripped.split("|").map(c => c.trim());
		return cells.length >= 2 ? cells : null;
	}

	function isTableSep(line, cols) {
		const cells = parseTableRow(line);
		return !!cells && cells.length === cols && cells.every(c => /^:?-{2,}:?$/.test(c));
	}

	function renderMarkdown(container, src) {
		container.replaceChildren();
		const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
		let i = 0;
		const para = [];
		const flushPara = () => {
			if (!para.length) return;
			const p = document.createElement("p");
			appendInline(p, para.join(" "));
			container.append(p);
			para.length = 0;
		};
		while (i < lines.length) {
			const line = lines[i];
			const fence = /^\s*(`{3,}|~{3,})/.exec(line);
			if (fence) {
				flushPara();
				const ch = fence[1][0];
				const len = fence[1].length;
				const code = [];
				i++;
				while (i < lines.length) {
					const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[i]);
					if (close && close[1][0] === ch && close[1].length >= len) {
						i++;
						break;
					}
					code.push(lines[i++]);
				}
				const pre = document.createElement("pre");
				pre.append(el("code", "", code.join("\n")));
				container.append(pre);
				continue;
			}
			if (!line.trim()) {
				flushPara();
				i++;
				continue;
			}
			if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
				flushPara();
				container.append(document.createElement("hr"));
				i++;
				continue;
			}
			const heading = /^(#{1,4})\s+(.*)$/.exec(line.trim());
			if (heading) {
				flushPara();
				const h = document.createElement(`h${heading[1].length}`);
				appendInline(h, heading[2]);
				container.append(h);
				i++;
				continue;
			}
			if (/^\s*>\s?/.test(line)) {
				flushPara();
				const bq = document.createElement("blockquote");
				const q = [];
				while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
					q.push(lines[i++].replace(/^\s*>\s?/, ""));
				}
				const p = document.createElement("p");
				appendInline(p, q.join(" "));
				bq.append(p);
				container.append(bq);
				continue;
			}
			const headerCells = parseTableRow(line);
			if (headerCells && i + 1 < lines.length && isTableSep(lines[i + 1], headerCells.length)) {
				flushPara();
				const table = document.createElement("table");
				const thead = document.createElement("thead");
				const hr = document.createElement("tr");
				for (const c of headerCells) {
					const th = document.createElement("th");
					appendInline(th, c);
					hr.append(th);
				}
				thead.append(hr);
				table.append(thead);
				const tbody = document.createElement("tbody");
				i += 2;
				while (i < lines.length) {
					const rowCells = parseTableRow(lines[i]);
					if (!rowCells || rowCells.length !== headerCells.length) break;
					const tr = document.createElement("tr");
					for (const c of rowCells) {
						const td = document.createElement("td");
						appendInline(td, c);
						tr.append(td);
					}
					tbody.append(tr);
					i++;
				}
				table.append(tbody);
				container.append(table);
				continue;
			}
			if (/^\s*[-*]\s+/.test(line)) {
				flushPara();
				const ul = document.createElement("ul");
				while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
					const li = document.createElement("li");
					appendInline(li, lines[i++].replace(/^\s*[-*]\s+/, ""));
					ul.append(li);
				}
				container.append(ul);
				continue;
			}
			if (/^\s*\d+\.\s+/.test(line)) {
				flushPara();
				const ol = document.createElement("ol");
				while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
					const li = document.createElement("li");
					appendInline(li, lines[i++].replace(/^\s*\d+\.\s+/, ""));
					ol.append(li);
				}
				container.append(ol);
				continue;
			}
			para.push(line.trim());
			i++;
		}
		flushPara();
	}

	function parseReelList(raw, conv, tok, msgs, postBySeq) {
		if (!Array.isArray(raw)) return [];
		const out = [];
		const keyCounts = new Map();
		for (const f of raw) {
			if (out.length >= 40) break;
			if (!f || typeof f !== "object") continue;
			const seq = Number(f.seq) || 0;
			const post = postBySeq.get(seq) || msgs.find(m => m.seq >= seq);
			const when = post && post.ts
				? new Date(post.ts).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })
				: "";
			const agent = typeof f.agent === "string" && f.agent ? f.agent : (post && post.agent ? post.agent : "");
			const isMarkdown = f.kind === "markdown" || typeof f.markdown === "string";
			if (isMarkdown) {
				const rawMd = typeof f.markdown === "string" ? f.markdown : typeof f.text === "string" ? f.text : "";
				if (!rawMd.trim()) continue;
				const markdown = rawMd.trim().slice(0, 2000);
				const cap = String(f.caption || "").slice(0, 90);
				const baseKey = `md:${seq}`;
				const n = (keyCounts.get(baseKey) || 0) + 1;
				keyCounts.set(baseKey, n);
				out.push({
					key: n === 1 ? baseKey : `${baseKey}#${n}`,
					contentKey: `md:${cap}\0${markdown}`,
					kind: "markdown",
					seq,
					agent,
					when,
					cap,
					markdown,
				});
				continue;
			}
			if (
				(f.kind === undefined || f.kind === "image") &&
				typeof f.path === "string" &&
				f.path.length > 0 &&
				f.path.length <= 4096 &&
				f.path.startsWith("/") &&
				!/[%\0\\]/.test(f.path) &&
				!f.path.split("/").some(seg => seg === "." || seg === "..") &&
				/\.(?:png|jpe?g|webp)$/i.test(f.path)
			) {
				const baseKey = `img:${f.path}`;
				const n = (keyCounts.get(baseKey) || 0) + 1;
				keyCounts.set(baseKey, n);
				const cap = String(f.caption || "").slice(0, 90);
				const src = `/api/frame?conversationId=${encodeURIComponent(conv)}&path=${encodeURIComponent(f.path)}&seq=${seq}${tok ? `&token=${encodeURIComponent(tok)}` : ""}`;
				out.push({
					key: n === 1 ? baseKey : `${baseKey}#${n}`,
					contentKey: `img:${src}`,
					kind: "image",
					seq,
					agent,
					when,
					cap,
					src,
				});
			}
		}
		return out;
	}

	function reelFramesOf(s) {
		if (!s) return [];
		const vj = s.view && s.view.json && typeof s.view.json === "object" ? s.view.json : null;
		const conv = s.conversationId || "";
		const tok = new URLSearchParams(location.search).get("token") || "";
		const msgs = Array.isArray(s.messages) ? s.messages : [];
		const postBySeq = new Map(msgs.map(m => [m.seq, m]));
		const fromView = vj && vj.reel ? parseReelList(vj.reel.frames, conv, tok, msgs, postBySeq) : [];
		return fromView.length ? fromView : parseReelList(s.frames, conv, tok, msgs, postBySeq);
	}

	function indexForKey(frames, key) {
		if (!frames.length) return -1;
		if (key === null) return frames.length - 1;
		const idx = frames.findIndex(f => f.key === key);
		return idx >= 0 ? idx : frames.length - 1;
	}

	function closeTimelineModal() {
		if (activeModal) {
			const m = activeModal;
			activeModal = null;
			m.close();
		}
		const leftover = document.querySelector(".o2-tv");
		if (leftover) leftover.remove();
	}

	function openTimelineModal(initialFrames, initialSig, startKey, onMove) {
		closeTimelineModal();
		if (!initialFrames.length) return;
		let frames = initialFrames;
		let modalSig = initialSig;
		const back = document.activeElement;
		const lb = el("div", "o2-tv");
		lb.setAttribute("role", "dialog");
		lb.setAttribute("aria-modal", "true");
		lb.setAttribute("aria-label", "Progress");
		const head = el("div", "o2-tvh");
		const title = el("b", "", "Progress");
		const pos = el("span", "o2-tvpos");
		const when = el("span", "o2-tvwhen");
		const closeBtn = el("button", "o2-tvx", "✕");
		closeBtn.type = "button";
		closeBtn.setAttribute("aria-label", "Close");
		head.append(title, pos, when, closeBtn);

		const stage = el("div", "o2-tvstage");
		const scroller = el("div", "o2-tvscroll");
		const prevBtn = el("button", "o2-tvnav prev", "‹");
		prevBtn.type = "button";
		prevBtn.setAttribute("aria-label", "Previous");
		const nextBtn = el("button", "o2-tvnav next", "›");
		nextBtn.type = "button";
		nextBtn.setAttribute("aria-label", "Next");
		stage.append(scroller, prevBtn, nextBtn);

		const textBox = el("div", "o2-tvtext");
		const cap = el("p", "o2-tvcap");
		const meta = el("p", "o2-tvmeta");
		textBox.append(cap, meta);

		const strip = el("div", "o2-tvstrip");
		strip.setAttribute("role", "listbox");
		strip.setAttribute("aria-label", "Progress updates");
		let thumbs = [];
		let currentKey = startKey;
		let currentIdx = -1;
		let renderedKey = null;
		let renderedContentKey = null;

		const rebuildStrip = () => {
			strip.replaceChildren();
			thumbs = frames.map((f, k) => {
				const btn = el("button", "o2-tvth");
				btn.type = "button";
				btn.setAttribute("role", "option");
				btn.setAttribute("aria-label", `${k + 1}. ${f.cap || (f.kind === "markdown" ? "Progress update" : "Screenshot")}`);
				if (f.kind === "image") {
					const im = document.createElement("img");
					im.src = f.src;
					im.alt = "";
					im.loading = "lazy";
					btn.append(im);
				} else {
					btn.append(el("div", "omp-tvth-md", f.cap || f.markdown.slice(0, 60)));
				}
				btn.append(el("span", "", String(k + 1)));
				btn.onclick = () => go(k, false);
				strip.append(btn);
				return btn;
			});
		};

		const go = (k, silent) => {
			if (!frames.length) {
				close();
				return;
			}
			const n = Math.max(0, Math.min(frames.length - 1, k));
			const f = frames[n];
			if (!f) return;
			const changedFrame = renderedKey !== f.key;
			const changedContent = changedFrame || renderedContentKey !== f.contentKey;
			currentIdx = n;
			currentKey = n === frames.length - 1 ? null : f.key;
			if (changedContent) {
				renderedKey = f.key;
				renderedContentKey = f.contentKey;
				scroller.className = "o2-tvscroll";
				scroller.replaceChildren();
				if (f.kind === "image") {
					const im = el("img", "o2-tvimg");
					im.src = f.src;
					im.alt = f.cap || "";
					im.onclick = () => scroller.classList.toggle("zoom");
					scroller.append(im);
				} else {
					scroller.classList.add("omp-tv-doc");
					const doc = el("article", "omp-tv-md");
					renderMarkdown(doc, f.markdown);
					scroller.append(doc);
				}
			}
			pos.textContent = n === frames.length - 1 ? `Now · ${n + 1} / ${frames.length}` : `${n + 1} / ${frames.length}`;
			when.textContent = f.when || "";
			cap.textContent = f.cap || "";
			const metaParts = [];
			if (f.agent) metaParts.push(`@${f.agent}`);
			if (f.seq) metaParts.push(`#${f.seq}`);
			meta.textContent = metaParts.join(" · ");
			prevBtn.disabled = n === 0;
			nextBtn.disabled = n === frames.length - 1;
			thumbs.forEach((b, k2) => {
				const on = k2 === n;
				b.classList.toggle("on", on);
				b.setAttribute("aria-selected", String(on));
				if (on && changedFrame) b.scrollIntoView({ block: "nearest", inline: "center" });
			});
			if (onMove && !silent) onMove(currentKey);
		};

		const key = e => {
			if (e.key === "Escape") { e.preventDefault(); close(); }
			else if (e.key === "ArrowLeft") { e.preventDefault(); go(currentIdx - 1, false); }
			else if (e.key === "ArrowRight") { e.preventDefault(); go(currentIdx + 1, false); }
			else if (e.key === "Home") { e.preventDefault(); go(0, false); }
			else if (e.key === "End") { e.preventDefault(); go(frames.length - 1, false); }
		};
		const close = () => {
			document.removeEventListener("keydown", key, true);
			lb.remove();
			if (activeModal && activeModal.close === close) activeModal = null;
			const to = back && back.isConnected ? back : document.querySelector(".omp-reel .o2-rexp");
			if (to && typeof to.focus === "function") to.focus({ preventScroll: true });
		};

		const setFrames = (nextFrames, nextSig) => {
			if (nextSig && nextSig === modalSig) return;
			frames = nextFrames;
			modalSig = nextSig;
			if (!frames.length) {
				close();
				return;
			}
			rebuildStrip();
			go(indexForKey(frames, currentKey), true);
		};

		lb.append(head, stage, textBox, strip);
		document.body.append(lb);
		document.addEventListener("keydown", key, true);
		closeBtn.onclick = close;
		prevBtn.onclick = () => go(currentIdx - 1, false);
		nextBtn.onclick = () => go(currentIdx + 1, false);
		lb.onclick = e => {
			if (e.target === lb || e.target === scroller) close();
		};
		rebuildStrip();
		go(indexForKey(frames, startKey), true);
		lb.tabIndex = -1;
		lb.focus({ preventScroll: true });
		activeModal = { close, setFrames };
	}

	function shouldShowCaption(f) {
		if (!f.cap) return false;
		if (f.kind === "image") return true;
		if (f.markdown.includes("\n")) return true;
		const plain = f.markdown.replace(/[`*~_#]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
		return plain !== f.cap.trim().toLowerCase();
	}

	function createReelController(initialFrames, initialSig) {
		let frames = initialFrames;
		let sig = initialSig;
		let renderedFrameKey = null;
		let renderedContentKey = null;
		let savedScrollTop = 0;
		let focusedEl = null;

		const section = el("section", "o2-reel omp-reel");
		section.dataset.testid = "swarm-progress-reel";
		section.dataset.ompReelSig = sig;

		const head = el("div", "o2-rh");
		const lbl = el("span", "o2-glbl", "Progress");
		const tag = el("span", "o2-rtag");
		const when = el("span", "o2-rwhen");
		const ctrl = el("div", "omp-rctrl");
		const prevBtn = el("button", "omp-rnav prev", "‹");
		prevBtn.type = "button";
		prevBtn.setAttribute("aria-label", "Previous update");
		const nextBtn = el("button", "omp-rnav next", "›");
		nextBtn.type = "button";
		nextBtn.setAttribute("aria-label", "Next update");
		const expBtn = el("button", "o2-rexp omp-rexp");
		expBtn.type = "button";
		expBtn.setAttribute("aria-label", "Open full timeline");
		expBtn.title = "Open full timeline";
		expBtn.append(expandIcon());
		ctrl.append(prevBtn, nextBtn, expBtn);
		head.append(lbl, tag, when, ctrl);

		const stage = el("div", "o2-rstage");
		const cap = el("p", "o2-rcap");
		const meta = el("p", "o2-rmeta");
		const track = el("div", "o2-rtrack");
		const scrub = el("input", "o2-rscrub");
		scrub.type = "range";
		scrub.min = "0";
		scrub.step = "1";
		scrub.setAttribute("aria-label", "Scrub through progress");
		track.append(scrub);
		section.append(head, stage, cap, meta, track);
		stage.addEventListener("scroll", () => {
			if (stage.isConnected) savedScrollTop = stage.scrollTop;
		}, { passive: true });
		section.addEventListener("focusin", e => {
			focusedEl = e.target;
		});
		section.addEventListener("focusout", e => {
			if (section.isConnected && (!e.relatedTarget || !section.contains(e.relatedTarget))) {
				focusedEl = null;
			}
		});

		const currentIndex = () => indexForKey(frames, reelSelectedKey);

		const openModal = () => {
			openTimelineModal(frames, sig, reelSelectedKey, nextKey => {
				reelSelectedKey = nextKey;
				if (mountedReel) mountedReel.showByKey(nextKey);
			});
		};

		const syncTrack = () => {
			const multi = frames.length >= 2;
			prevBtn.hidden = !multi;
			nextBtn.hidden = !multi;
			track.hidden = !multi;
			for (const old of track.querySelectorAll(":scope > i")) old.remove();
			if (multi) {
				for (let k = 0; k < frames.length; k++) {
					const dot = document.createElement("i");
					dot.style.left = `${((k / (frames.length - 1)) * 100).toFixed(2)}%`;
					scrub.before(dot);
				}
				scrub.max = String(frames.length - 1);
			}
		};

		const show = idx => {
			const clamped = Math.max(0, Math.min(frames.length - 1, idx));
			const f = frames[clamped];
			if (!f) return;
			reelSelectedKey = clamped === frames.length - 1 ? null : f.key;
			tag.textContent = clamped === frames.length - 1 ? (frames.length === 1 ? "Now" : `Now · ${clamped + 1} / ${frames.length}`) : `${clamped + 1} / ${frames.length}`;
			when.textContent = f.when || "";
			const changedFrame = renderedFrameKey !== f.key;
			const changedContent = changedFrame || renderedContentKey !== f.contentKey;
			if (changedContent) {
				renderedFrameKey = f.key;
				renderedContentKey = f.contentKey;
				if (changedFrame) {
					savedScrollTop = 0;
					stage.scrollTop = 0;
				}
				stage.className = f.kind === "markdown" ? "o2-rstage omp-rstage-md" : "o2-rstage";
				stage.replaceChildren();
				if (f.kind === "image") {
					const im = el("img", "o2-rimg");
					im.src = f.src;
					im.alt = f.cap || "";
					im.onclick = openModal;
					stage.append(im);
				} else {
					const mdBox = el("div", "omp-rmd");
					mdBox.dataset.testid = "swarm-reel-markdown";
					renderMarkdown(mdBox, f.markdown);
					stage.append(mdBox);
				}
				if (!changedFrame) stage.scrollTop = savedScrollTop;
			}
			const showCap = shouldShowCaption(f);
			cap.textContent = showCap ? f.cap : "";
			cap.hidden = !showCap;
			meta.replaceChildren();
			if (f.agent) meta.append(el("span", "", `@${f.agent}`));
			if (f.agent && f.seq) meta.append(document.createTextNode("·"));
			if (f.seq) {
				const seqBtn = el("button", "omp-reel-seq", `#${f.seq}`);
				seqBtn.type = "button";
				seqBtn.dataset.ovSeq = String(f.seq);
				meta.append(seqBtn);
			}
			scrub.value = String(clamped);
			prevBtn.disabled = clamped <= 0;
			nextBtn.disabled = clamped >= frames.length - 1;
		};

		expBtn.onclick = e => {
			e.stopPropagation();
			openModal();
		};
		prevBtn.onclick = () => show(currentIndex() - 1);
		nextBtn.onclick = () => show(currentIndex() + 1);
		scrub.oninput = () => show(Number(scrub.value));

		syncTrack();
		show(currentIndex());

		return {
			el: section,
			stage,
			get sig() { return sig; },
			restoreUiState() {
				stage.scrollTop = savedScrollTop;
				if (
					focusedEl &&
					section.contains(focusedEl) &&
					(document.activeElement === document.body || document.activeElement === null) &&
					typeof focusedEl.focus === "function"
				) {
					focusedEl.focus({ preventScroll: true });
				}
			},
			showByKey(key) {
				reelSelectedKey = key;
				show(indexForKey(frames, key));
			},
			updateFrames(nextFrames, nextSig) {
				frames = nextFrames;
				sig = nextSig;
				section.dataset.ompReelSig = sig;
				syncTrack();
				show(currentIndex());
			},
		};
	}

	function syncReel() {
		const host = $("ov-plain");
		if (!host || !snap) return;
		if (snap.id !== reelSwarmId) {
			reelSwarmId = snap.id;
			reelSelectedKey = null;
			mountedReel = null;
			closeTimelineModal();
		}
		const root = host.querySelector(".o2");
		if (!root) return;
		const frames = reelFramesOf(snap);
		const existing = root.querySelector(".o2-reel");
		if (!frames.length) {
			if (existing && existing.classList.contains("omp-reel")) existing.remove();
			mountedReel = null;
			closeTimelineModal();
			return;
		}
		const sig = JSON.stringify(frames);
		if (activeModal) activeModal.setFrames(frames, sig);
		if (mountedReel && mountedReel.el.parentNode === root) {
			if (mountedReel.sig !== sig) mountedReel.updateFrames(frames, sig);
			return;
		}
		if (ovObserver) ovObserver.disconnect();
		try {
			if (!mountedReel) {
				mountedReel = createReelController(frames, sig);
			} else if (mountedReel.sig !== sig) {
				mountedReel.updateFrames(frames, sig);
			}
			if (existing && existing !== mountedReel.el) {
				existing.replaceWith(mountedReel.el);
			} else if (mountedReel.el.parentNode !== root) {
				const anchor = root.querySelector(".o2-threads") || root.querySelector(".o2-team");
				if (anchor) anchor.before(mountedReel.el);
				else root.append(mountedReel.el);
			}
			mountedReel.restoreUiState();
		} finally {
			if (ovObserver) ovObserver.observe(host, { childList: true, subtree: true });
		}
	}

	const ovPlain = $("ov-plain");
	if (ovPlain) {
		ovObserver = new MutationObserver(() => syncReel());
		ovObserver.observe(ovPlain, { childList: true, subtree: true });
	}

	window.addEventListener("omp:snapshot", e => {
		snap = e.detail;
		setTimeout(() => {
			syncNarratorLink();
			syncReel();
		}, 0);
	});
	if (snap) {
		setTimeout(() => {
			syncNarratorLink();
			syncReel();
		}, 0);
	}
	// Only the vendored mode toggle's class decides whether the link shows.
	const modeToggle = $("ov-mode");
	if (modeToggle) new MutationObserver(() => syncNarratorLink()).observe(modeToggle, { attributes: true, attributeFilter: ["class"] });
})();
