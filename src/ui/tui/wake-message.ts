// Renders `swarm-wake` deliveries in the main chat. They carry board posts, which are untrusted,
// and the host's default custom-message renderer would pass terminal escapes through (SW-12), so
// this keeps the host's framed look but sanitizes the body and shows it as plain text.

import { Box, type Component, Spacer, Text, type Theme } from "@oh-my-pi/pi-tui";
import { sanitize } from "../sanitize.ts";
import { textOf } from "../transcript.ts";

export function renderWakeMessage(message: { content: unknown }, _options: { expanded: boolean }, theme: Theme): Component {
	const box = new Box(1, 1, text => theme.bg("customMessageBg", text), {
		chars: theme.boxRound,
		color: text => theme.fg("borderMuted", text),
	});
	box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(`${theme.icon.package} swarm`)), 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(new Text(theme.fg("customMessageText", sanitize(textOf(message.content))), 0, 0));
	return box;
}
