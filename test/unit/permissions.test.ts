// The §8.2 permission matrix.

import { describe, expect, test } from "bun:test";
import { helperDepth, type Operation, permitted } from "../../src/tools/permissions.ts";

const C = { name: "coordinator", role: "coordinator" as const };
const W = { name: "w", role: "worker" as const };
const N = { name: "narrator", role: "narrator" as const };
const M = { name: "monitor", role: "monitor" as const };
const own = { name: "h", role: "worker" as const, addedBy: "w" };
const other = { name: "x", role: "worker" as const, addedBy: "coordinator" };
const self = { name: "w", role: "worker" as const, addedBy: "coordinator" };
const coordT = { name: "coordinator", role: "coordinator" as const, addedBy: "" };

describe("permissions", () => {
	test("read-only operations", () => {
		for (const op of ["status", "models", "channel_list", "read_board", "swarm_wait", "post_message"] as Operation[]) {
			expect(permitted(op, C)).toBeNull();
			expect(permitted(op, W)).toBeNull();
		}
		expect(permitted("read_board", N)).toBeNull();
		expect(permitted("swarm_wait", M)).toBeNull();
		expect(permitted("status", N)).not.toBeNull();
		expect(permitted("post_message", N)).not.toBeNull();
		expect(permitted("post_message", M)).toBeNull();
	});

	test("kill/revive: coordinator any worker; worker own helpers only; never the coordinator", () => {
		for (const op of ["kill", "revive"] as Operation[]) {
			expect(permitted(op, C, other)).toBeNull();
			expect(permitted(op, W, own)).toBeNull();
			expect(permitted(op, W, other)).toContain("only helpers it added");
			expect(permitted(op, C, coordT)).not.toBeNull();
			expect(permitted(op, M, other)).not.toBeNull();
		}
	});

	test("model: self and own helpers for workers; any member for the coordinator", () => {
		expect(permitted("model", C, other)).toBeNull();
		expect(permitted("model", C, coordT)).toBeNull();
		expect(permitted("model", W, self)).toBeNull();
		expect(permitted("model", W, own)).toBeNull();
		expect(permitted("model", W, other)).not.toBeNull();
		expect(permitted("model", W, coordT)).not.toBeNull();
		expect(permitted("model", N, self)).not.toBeNull();
	});

	test("fork sources, coordinator-only operations, subscriptions", () => {
		expect(permitted("fork", C, other)).toBeNull();
		expect(permitted("fork", W, self)).toBeNull();
		expect(permitted("fork", W, own)).toBeNull();
		expect(permitted("fork", W, other)).not.toBeNull();
		for (const op of ["finish", "title", "channel_create", "channel_archive"] as Operation[]) {
			expect(permitted(op, C)).toBeNull();
			expect(permitted(op, W)).not.toBeNull();
		}
		expect(permitted("channel_subscribe", C, other)).toBeNull();
		expect(permitted("channel_subscribe", W, self)).toBeNull();
		expect(permitted("channel_subscribe", W, own)).toBeNull();
		expect(permitted("channel_subscribe", W, other)).not.toBeNull();
		expect(permitted("channel_subscribe", C, coordT)).not.toBeNull();
	});

	test("helper depth", () => {
		const added: Record<string, string> = { a: "coordinator", b: "a", c: "b" };
		expect(helperDepth("a", n => added[n])).toBe(1);
		expect(helperDepth("b", n => added[n])).toBe(2);
		expect(helperDepth("c", n => added[n])).toBe(3);
	});
});
