// Transcript rows from the plugin render as plain text: persisted content can contain
// terminal escapes, even for messages whose live source is trusted.

import { Box, type Component, Spacer, Text, type Theme } from "@oh-my-pi/pi-tui";
import { sanitize } from "../sanitize.ts";
import { textOf } from "../transcript.ts";

function sanitizedCustomMessage(label: (theme: Theme) => string) {
	return (message: { content: unknown }, _options: { expanded: boolean }, theme: Theme): Component => {
		const box = new Box(1, 1, text => theme.bg("customMessageBg", text), {
			chars: theme.boxRound,
			color: text => theme.fg("borderMuted", text),
		});
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(label(theme))), 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(new Text(theme.fg("customMessageText", sanitize(textOf(message.content))), 0, 0));
		return box;
	};
}

export const renderWakeMessage = sanitizedCustomMessage(theme => `${theme.icon.package} swarm`);
export const renderWebBoardMessage = sanitizedCustomMessage(() => "Swarm web board");
