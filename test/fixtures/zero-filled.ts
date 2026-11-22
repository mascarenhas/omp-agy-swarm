// The reported Codex call, before the schema offered an empty effort/operation.
export const legacyAdd = {
	action: "add",
	name: "probe",
	brief: "…",
	model: "openai-codex/gpt-6-luna:low",
	effort: "off",
	tasks: [],
	n: 0,
	fork: "",
	workspace: "inherit",
	channels: [],
	role: "worker",
	discard_ignored: false,
	keep_workspace: false,
	summary: "",
	abandon: false,
	title: "",
	op: "create",
	channel: "",
	topic: "",
	query: "",
	provider: "",
	limit: 40,
};

// Keep the original field set and padding, with the new schema's omission choices.
export const paddedAdd = { ...legacyAdd, effort: "", op: "" };
export const paddedRead = { since: null, limit: 0, channel: "", status: false };
export const paddedWait = { since: null, mentions_only: null, timeout_seconds: 0 };