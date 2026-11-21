// The §8.2 permission matrix. PURE: board types only.

import type { Role } from "../board/types.ts";

export type Operation =
	| "status"
	| "models"
	| "channel_list"
	| "read_board"
	| "swarm_wait"
	| "add"
	| "fork"
	| "kill"
	| "revive"
	| "model"
	| "finish"
	| "title"
	| "channel_create"
	| "channel_archive"
	| "channel_subscribe"
	| "post_message";

export interface Actor {
	name: string;
	role: Role;
}

export interface Target {
	name: string;
	role: Role;
	addedBy: string;
}

const ROLE_ONLY: Readonly<Record<string, true>> = { read_board: true, swarm_wait: true };

/** Returns null when allowed, else the refusal text. `target` is required for per-member operations. */
export function permitted(op: Operation, actor: Actor, target?: Target): string | null {
	const deny = (why: string) => why;
	if (actor.role === "narrator" || actor.role === "monitor") {
		if (Object.hasOwn(ROLE_ONLY, op)) return null;
		if (op === "post_message" && actor.role === "monitor") return null;
		return deny(`${actor.role} members may only read the board and wait${actor.role === "monitor" ? " (and post)" : ""}`);
	}
	const coordinator = actor.role === "coordinator";
	const ownHelper = !!target && target.addedBy === actor.name && target.role === "worker";
	const self = !!target && target.name === actor.name;
	switch (op) {
		case "status":
		case "models":
		case "channel_list":
		case "read_board":
		case "swarm_wait":
		case "post_message":
			return null;
		case "add":
			return null; // role and depth rules are checked by the add validation
		case "fork":
			if (!target) return deny("fork needs a source");
			if (coordinator) return null;
			return self || ownHelper ? null : deny(`a worker can fork only itself or a helper it added, not ${target.name}`);
		case "kill":
		case "revive":
			if (!target) return deny(`${op} needs a target`);
			if (target.role === "coordinator") return deny(`the coordinator cannot be ${op === "kill" ? "killed" : "revived"}`);
			if (coordinator) return null;
			return ownHelper ? null : deny(`${actor.name} can ${op} only helpers it added; ${target.name} was added by ${target.addedBy || "coordinator"}`);
		case "model":
			if (!target) return deny("model needs a target");
			if (coordinator) return null;
			if (target.role === "coordinator") return deny("only the coordinator changes its own model");
			return self || ownHelper ? null : deny(`${actor.name} can change only its own model or a helper's, not ${target.name}'s`);
		case "finish":
		case "title":
		case "channel_create":
		case "channel_archive":
			return coordinator ? null : deny(`only the coordinator can ${op.replace("_", " ")}`);
		case "channel_subscribe":
			if (!target) return deny("subscribe needs a member");
			if (target.role === "coordinator") return deny("the coordinator sees every channel");
			if (coordinator) return null;
			return self || ownHelper ? null : deny(`${actor.name} can subscribe only itself or its helpers`);
	}
}

/** Helper depth of a worker: 1 when the coordinator added it, its adder's depth + 1 otherwise. */
export function helperDepth(name: string, addedByOf: (n: string) => string | undefined): number {
	let depth = 0;
	let cur: string | undefined = name;
	const seen = new Set<string>();
	while (cur && cur !== "coordinator" && !seen.has(cur)) {
		seen.add(cur);
		depth++;
		cur = addedByOf(cur);
	}
	return depth;
}
