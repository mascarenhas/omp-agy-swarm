/*
 * omp-agy-swarm web board preload: the first script on the page.
 * window.sidecar.fetch only reaches same-origin allowlisted paths, omits credentials and
 * refuses redirects. The preload also writes the host theme tokens onto :root.
 */
(() => {
	"use strict";
	const ALLOWED = new Set(["/api/swarm", "/api/frame", "/api/transcript", "/api/file", "/narrator_bootstrap.js"]);
	let lastSnapshot = null;
	async function sidecarFetch(path, init) {
		const url = new URL(String(path), location.origin);
		if (url.origin !== location.origin || !ALLOWED.has(url.pathname)) throw new TypeError("sidecar.fetch: path not allowed");
		const method = (init && init.method) || "GET";
		if (method !== "GET") throw new TypeError("sidecar.fetch: only GET");
		const res = await fetch(url.pathname + url.search, {
			method: "GET",
			credentials: "omit",
			cache: "no-store",
			redirect: "error",
		});
		if (url.pathname === "/api/swarm" && res.ok) {
			res
				.clone()
				.json()
				.then(j => {
					if (!j || j.unchanged) return;
					// Kept for scripts that load after this snapshot arrived (later polls only say
					// `unchanged`, so the event alone would be lost to them).
					lastSnapshot = j;
					window.dispatchEvent(new CustomEvent("omp:snapshot", { detail: j }));
				})
				.catch(() => {});
		}
		return res;
	}

	// 20 host theme tokens (light and dark), written as inline style properties on :root.
	const THEMES = {
		light: {
			background: "#f7f7f8",
			foreground: "#1d1f21",
			card: "#ffffff",
			"card-foreground": "#1d1f21",
			"card-border": "rgba(0,0,0,0.1)",
			secondary: "#e6e7e9",
			"secondary-foreground": "#3d4348",
			muted: "#eff0f1",
			"muted-foreground": "#5d676f",
			placeholder: "#9da5ab",
			border: "rgba(0,0,0,0.08)",
			primary: "#007acc",
			"primary-foreground": "#ffffff",
			error: "#cb3d3d",
			accent: "#e8f2fb",
			"accent-foreground": "#0b4f80",
			ring: "#007acc",
			input: "#ffffff",
			"font-family": 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
			"editor-font-family": 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
		},
		dark: {
			background: "#16181b",
			foreground: "#e3e5e8",
			card: "#1e2125",
			"card-foreground": "#e3e5e8",
			"card-border": "rgba(255,255,255,0.1)",
			secondary: "#2a2e33",
			"secondary-foreground": "#c3c8ce",
			muted: "#23272b",
			"muted-foreground": "#9aa3ab",
			placeholder: "#6b747c",
			border: "rgba(255,255,255,0.08)",
			primary: "#3d9be9",
			"primary-foreground": "#0b1117",
			error: "#e5534b",
			accent: "#1b2b3a",
			"accent-foreground": "#9ccbf3",
			ring: "#3d9be9",
			input: "#1e2125",
			"font-family": 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
			"editor-font-family": 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
		},
	};
	function applyTheme(name) {
		const t = THEMES[name] || THEMES.light;
		for (const [k, v] of Object.entries(t)) document.documentElement.style.setProperty(`--${k}`, v);
	}
	let theme = "";
	try {
		theme = localStorage.getItem("swarm.theme") || "";
	} catch {}
	if (theme !== "light" && theme !== "dark") theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
	applyTheme(theme);

	window.sidecar = Object.freeze({
		conversationId: "",
		fetch: sidecarFetch,
		/** The latest full /api/swarm snapshot, or null before the first one. */
		snapshot: () => lastSnapshot,
		ui: Object.freeze({
			toggleConversation(id) {
				window.dispatchEvent(new CustomEvent("omp:conversation", { detail: String(id || "") }));
			},
			toggleAuxPane(opts) {
				window.dispatchEvent(new CustomEvent("omp:aux", { detail: opts || {} }));
			},
		}),
		theme: Object.freeze({
			apply: applyTheme,
		}),
	});
})();
