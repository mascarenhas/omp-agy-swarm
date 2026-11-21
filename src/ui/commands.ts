// /swarm (the native TUI, primary surface) and /swarm-ui (the opt-in web board), plus the status
// widget. The web server object is constructed only on /swarm-ui start (or OMP_SWARM_UI=1 in an
// interactive session); no port is ever bound at load.

import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SwarmEnv } from "../env.ts";
import type { CoordinatorBinding } from "../runtime/coordinator.ts";
import { RuntimeReadModel } from "../runtime/read-model.ts";
import type { SwarmRuntime } from "../runtime/runtime.ts";
import { project, type SwarmReadModel } from "./model.ts";
import { EmptyOverlay, SwarmOverlay } from "./tui/overlay.ts";
import type { ViewId } from "./tui/view.ts";
import { renderWakeMessage } from "./tui/wake-message.ts";
import { widgetComponent, widgetLine } from "./tui/widget.ts";
import { WebBoard } from "./web/server.ts";

export interface UiHost {
	runtime(sid: string): SwarmRuntime | undefined;
	refusal(sid: string): string | undefined;
	bind(ctx: ExtensionContext): CoordinatorBinding;
	env: SwarmEnv;
	packageDir: string;
}

export interface CommandsHandle {
	onRuntime(rt: SwarmRuntime): void;
	onShutdown(rt: SwarmRuntime): void;
}

const VIEWS: Record<string, ViewId> = { overview: "overview", board: "board", members: "members", transcript: "transcript" };

function summary(model: SwarmReadModel): string {
	const v = project(model);
	const lines = [widgetLine(model), `goal: ${v.goal}`, `state: ${v.stateLine}`];
	for (const m of model.members()) if (m.role !== "coordinator") lines.push(`${m.name}: ${m.state} · ${m.detail}${m.failure ? ` · failed (${m.failure.kind})` : ""}`);
	for (const a of v.attention.slice(0, 8)) lines.push(`! ${a.text}`);
	return lines.join("\n");
}

export function registerCommands(pi: ExtensionAPI, host: UiHost): CommandsHandle {
	const models = new Map<string, RuntimeReadModel>();
	const boards = new Map<string, WebBoard>();
	const widgets = new Set<string>();

	pi.registerMessageRenderer("swarm-wake", renderWakeMessage);

	const modelOf = (rt: SwarmRuntime): RuntimeReadModel => {
		let m = models.get(rt.sid);
		if (!m || m.rt !== rt) {
			m = new RuntimeReadModel(rt);
			models.set(rt.sid, m);
		}
		return m;
	};

	const startBoard = (rt: SwarmRuntime, port: number): { board?: WebBoard; error?: string } => {
		let board = boards.get(rt.sid);
		if (!board) {
			try {
				board = new WebBoard(modelOf(rt), { webDir: join(host.packageDir, "web"), swarmDir: rt.dir, extraRoots: host.env.uiRoots });
			} catch (err) {
				return { error: `the web board's files are missing: ${(err as Error).message}` };
			}
			boards.set(rt.sid, board);
		}
		if (!board.running) {
			try {
				board.start(port);
			} catch (err) {
				return { error: `could not listen on 127.0.0.1:${port}: ${(err as Error).message}` };
			}
		}
		return { board };
	};

	const announce = (b: CoordinatorBinding, board: WebBoard): void => {
		const port = board.port;
		b.notify(
			`Swarm web board (read-only; anyone with this link sees the board and every member's transcript until it expires in 5 minutes):\n${board.link()}\nRemote session? Forward the same port first: ssh -L ${port}:127.0.0.1:${port} <host>`,
			"info",
		);
	};

	const installWidget = (rt: SwarmRuntime): void => {
		const b = rt.binding as CoordinatorBinding;
		if (b.mode !== "tui" || widgets.has(rt.sid)) return;
		const ctx = b.ctx;
		try {
			ctx.ui.setWidget("swarm", (tui: unknown) => widgetComponent(modelOf(rt), tui as { requestRender(): void }), { placement: "belowEditor" });
			widgets.add(rt.sid);
		} catch {}
	};

	pi.registerCommand("swarm", {
		description: "Open the swarm board (overview | board | members | transcript [name])",
		getArgumentCompletions: prefix =>
			Object.keys(VIEWS)
				.filter(v => v.startsWith(prefix))
				.map(v => ({ value: v, label: v })),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (ctx.agent.kind !== "main") return;
			const b = host.bind(ctx);
			const rt = host.runtime(b.sessionId);
			const [viewArg, name] = args.trim().split(/\s+/).filter(Boolean);
			const view = (viewArg && VIEWS[viewArg]) || "overview";
			if (ctx.mode !== "tui") {
				if (ctx.mode === "rpc") ctx.ui.notify(rt ? summary(modelOf(rt)) : host.refusal(b.sessionId) ?? "No swarm in this session yet.", "info");
				return;
			}
			const options = {
				overlay: true,
				overlayOptions: { width: "100%" as const, maxHeight: "100%" as const, margin: 0, fullscreen: true, mouseTracking: false },
			};
			if (!rt) {
				await ctx.ui.custom<void>((tui, _theme, kb, done) => new EmptyOverlay(tui, kb, () => done(undefined), host.refusal(b.sessionId)), options);
				return;
			}
			const model = modelOf(rt);
			await ctx.ui.custom<void>(
				(tui, theme, kb, done) => new SwarmOverlay(model, tui, theme, kb, () => done(undefined), view, name ? { member: name } : undefined),
				options,
			);
		},
	});

	pi.registerCommand("swarm-ui", {
		description: "Optional web board: status | start [port] | open | stop",
		getArgumentCompletions: prefix =>
			["status", "start", "open", "stop"].filter(v => v.startsWith(prefix)).map(v => ({ value: v, label: v })),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (ctx.agent.kind !== "main") return;
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
			const b = host.bind(ctx);
			const rt = host.runtime(b.sessionId);
			const [sub = "status", portArg] = args.trim().split(/\s+/).filter(Boolean);
			const existing = rt ? boards.get(rt.sid) : undefined;
			if (sub === "status") {
				if (existing?.running) ctx.ui.notify(`Web board is on 127.0.0.1:${existing.port}. /swarm-ui open shows a new private link; /swarm-ui stop closes it.`, "info");
				else
					ctx.ui.notify(
						"Web board is off. `/swarm-ui start` binds 127.0.0.1 only and shows a private link. Over SSH forward the port first: ssh -L <port>:127.0.0.1:<port> <host>.",
						"info",
					);
				return;
			}
			if (sub === "stop") {
				existing?.stop();
				ctx.ui.notify(existing ? "Web board stopped; its links no longer work." : "Web board is not running.", "info");
				return;
			}
			if (sub !== "start" && sub !== "open") {
				ctx.ui.notify("usage: /swarm-ui [status|start [port]|open|stop]", "warning");
				return;
			}
			if (!rt) {
				ctx.ui.notify(host.refusal(b.sessionId) ?? "No swarm in this session yet.", "warning");
				return;
			}
			const port = portArg !== undefined ? Number(portArg) : host.env.uiPort;
			if (!Number.isInteger(port) || port < 0 || port > 65535) {
				ctx.ui.notify(`invalid port ${portArg}`, "warning");
				return;
			}
			const r = startBoard(rt, port);
			if (!r.board) {
				ctx.ui.notify(r.error ?? "could not start the web board", "error");
				return;
			}
			announce(b, r.board);
			if (sub === "open") {
				const link = r.board.link();
				try {
					Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", link], { stdout: "ignore", stderr: "ignore" });
				} catch {}
			}
		},
	});

	return {
		onRuntime(rt: SwarmRuntime): void {
			installWidget(rt);
			const b = rt.binding as CoordinatorBinding;
			const restored = modelOf(rt).restored();
			if (restored) b.notify(`swarm restored: ${restored.stopped} members stopped, ${restored.owed} with unread posts — swarm{action:"revive"} brings them back`, "info");
			if (host.env.ui && (b.mode === "tui" || b.mode === "rpc") && !boards.get(rt.sid)?.running) {
				const r = startBoard(rt, host.env.uiPort);
				if (r.board) announce(b, r.board);
				else if (r.error) b.notify(r.error, "warning");
			}
		},
		onShutdown(rt: SwarmRuntime): void {
			boards.get(rt.sid)?.stop();
			boards.delete(rt.sid);
			if (widgets.has(rt.sid)) {
				try {
					(rt.binding as CoordinatorBinding).ctx.ui.setWidget("swarm", undefined);
				} catch {}
				widgets.delete(rt.sid);
			}
			models.delete(rt.sid);
		},
	};
}
