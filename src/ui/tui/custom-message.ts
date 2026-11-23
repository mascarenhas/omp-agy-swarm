// Transcript rows from the plugin render as plain text: persisted content can contain
// terminal escapes, even for messages whose live source is trusted.

import { Box, type Component, Spacer, Text, type Theme } from "@oh-my-pi/pi-tui";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { sanitize } from "../sanitize.ts";
import { textOf } from "../transcript.ts";
import { group, NativeCache, nativeKey, text } from "./native.ts";

function sanitizedCustomMessage(role: string, heading: string, label: (theme: Theme) => string) {
	return (message: { content: unknown }, _options: { expanded: boolean }, theme: Theme): Component => {
		const body = sanitize(textOf(message.content));
		const native = new NativeCache();
		const box = new Box(1, 1, text => theme.bg("customMessageBg", text), {
			chars: theme.boxRound,
			color: text => theme.fg("borderMuted", text),
		});
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(label(theme))), 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(new Text(theme.fg("customMessageText", body), 0, 0));
		return {
			render: width => box.render(width),
			invalidate: () => box.invalidate(),
			describe(cx: DescribeContext) {
				if (!cx.supports("text")) return null;
				return native.get(nativeKey(cx), () => cx.supports("col") || cx.supports("row")
					? group(cx, "notice", [text("heading", heading, "strong"), text("body", body)], role)
					: text("notice", `${heading}\n${body}`, undefined, role));
			},
		};
	};
}

export const renderWakeMessage = sanitizedCustomMessage("omp.swarm.wake", "Swarm wake", theme => `${theme.icon.package} swarm`);
export const renderWebBoardMessage = sanitizedCustomMessage("omp.swarm.webNotice", "Swarm web board", () => "Swarm web board");
