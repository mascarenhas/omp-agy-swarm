// Transcript rows from the plugin render as plain text: persisted content can contain
// terminal escapes, even for messages whose live source is trusted.

import type { ExtensionTheme } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/render-types";
import { nativeRendering, type JSXNode } from "@oh-my-pi/pi-tui";
import { fit, pad, sanitize, wrap } from "../sanitize.ts";
import { textOf } from "../transcript.ts";
import { col, node, text } from "./native.ts";

function notice(role: string, heading: string, label: (theme: ExtensionTheme) => string) {
	return (message: { content: unknown }, _options: { expanded: boolean }, theme: ExtensionTheme): JSXNode => {
		const body = sanitize(textOf(message.content));
		return () => nativeRendering()
			? col("notice", [text("heading", heading, "strong"), text("body", body)], role)
			: node("canvas", "notice", {
				paint: width => {
					if (width < 5) return [fit(heading, width)];
					const { topLeft, topRight, bottomLeft, bottomRight, horizontal, vertical } = theme.symbols.box;
					const border = (line: string) => theme.bg("customMessageBg", theme.fg("borderMuted", line));
					const edge = border(vertical);
					const room = width - 4;
					const line = (value: string) => `${edge}${theme.bg("customMessageBg", ` ${pad(value, room)} `)}${edge}`;
					return [
						border(topLeft + horizontal.repeat(width - 2) + topRight),
						line(theme.fg("customMessageLabel", theme.bold(label(theme)))),
						line(""),
						...wrap(body, room).map(part => line(theme.fg("customMessageText", part))),
						border(bottomLeft + horizontal.repeat(width - 2) + bottomRight),
					];
				},
			});
	};
}

export const renderWakeMessage = notice("omp.swarm.wake", "Swarm wake", theme => `${theme.symbols.icon("package")} swarm`.trim());
export const renderWebBoardMessage = notice("omp.swarm.webNotice", "Swarm web board", () => "Swarm web board");
export const renderDirectMessage = notice("omp.swarm.dm", "Swarm DM", () => "Swarm DM");
