// /swarm (the native TUI, primary surface) and /swarm-ui (the opt-in web board), plus the status
// widget. The listener starts only on /swarm-ui start or open, or when an interactive swarm
// attaches with OMP_SWARM_UI=1.

import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SwarmEnv } from "../env.ts";
import type { CoordinatorBinding } from "../runtime/coordinator.ts";
import { RuntimeReadModel } from "../runtime/read-model.ts";
import type { SwarmRuntime } from "../runtime/runtime.ts";
import { project, type SwarmReadModel } from "./model.ts";
import { renderDirectMessage, renderWakeMessage, renderWebBoardMessage } from "./tui/custom-message.ts";
import { EmptyOverlay, SwarmOverlay } from "./tui/overlay.ts";
import type { ViewId } from "./tui/view.ts";
import { createWidgetLink, widgetComponent, widgetLine, type WidgetLink } from "./tui/widget.ts";
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
	const widgets = new Map<string, WidgetLink>();

	pi.registerMessageRenderer("swarm-wake", renderWakeMessage);
	pi.registerMessageRenderer("swarm-ui", renderWebBoardMessage);
	pi.registerMessageRenderer("swarm-dm", renderDirectMessage);

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
			widgets.get(rt.sid)?.set(board.link());
		}
		return { board };
	};

	const announce = (b: CoordinatorBinding, board: WebBoard): string | undefined => {
		const port = board.port;
		const link = board.link();
		if (port === undefined || link === undefined) return;
		// The host queues context-excluded transcript rows until a live turn ends.
		b.notify(`Web board: ${link}`, "info");
		pi.sendMessage(
			{
				customType: "swarm-ui",
				content: `${link}\ntailscale serve ${port}\nssh -L ${port}:127.0.0.1:${port} <host>\nRead-only. Anyone who can reach the board can read it.`,
				display: true,
				excludeFromContext: true,
			},
			{ triggerTurn: false },
		);
		return link;
	};

	const installWidget = (rt: SwarmRuntime): void => {
		const b = rt.binding as CoordinatorBinding;
		if (b.mode !== "tui" || widgets.has(rt.sid)) return;
		const ctx = b.ctx;
		const link = createWidgetLink(boards.get(rt.sid)?.link());
		widgets.set(rt.sid, link);
		try {
			ctx.ui.setWidget(
				"swarm",
				ui => widgetComponent(modelOf(rt), ui, link),
				{ placement: "belowEditor" },
			);
		} catch { widgets.delete(rt.sid); }
	};

	pi.registerCommand("swarm", {
		description: "Open the read-only swarm dashboard (overview | board | members | transcript [name])",
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
			const options = { overlay: true, fullscreen: true };
			let overlay: EmptyOverlay | SwarmOverlay | undefined;
			try {
				await ctx.ui.custom<void>((ui, theme, kb, done) => {
					const close = () => done(undefined);
					overlay = rt
						? new SwarmOverlay(modelOf(rt), ui, theme, kb, close, view, name ? { member: name } : undefined)
						: new EmptyOverlay(ui, kb, close, host.refusal(b.sessionId));
					return overlay.component();
				}, options);
			} finally {
				overlay?.dispose();
			}
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
				if (existing?.running) announce(b, existing);
				else ctx.ui.notify("Web board is off. /swarm-ui start starts a read-only board on 127.0.0.1.", "info");
				return;
			}
			if (sub === "stop") {
				if (rt && existing?.running) {
					existing.stop();
					widgets.get(rt.sid)?.set(undefined);
					ctx.ui.notify("Web board stopped.", "info");
				} else ctx.ui.notify("Web board is not running.", "info");
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
			const link = announce(b, r.board);
			if (sub === "open" && link) {
				try {
					Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", link], { stdout: "ignore", stderr: "ignore" });
				} catch {}
			}
		},
	});

	return {
		onRuntime(rt: SwarmRuntime): void {
			const b = rt.binding as CoordinatorBinding;
			if (b.pi !== pi) return; // The process-wide registry also reaches factories rebound into workers.
			rt.webBoardLink = () => boards.get(rt.sid)?.link();
			installWidget(rt);
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
