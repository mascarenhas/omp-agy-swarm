import { expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgAsyncPrintWake as printWake } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { leasePrintWake } from "../../src/runtime/print-wake.ts";

const own = (s: Settings): unknown => (s.overlayLayers().overrides.async as { printWake?: boolean } | undefined)?.printWake;

test("print-wake lease restores the exact own slot on last release, not the first", () => {
	for (const prior of [false, undefined]) {
		const settings = Settings.isolated({ "async.printWake": prior });
		const one = leasePrintWake(settings, printWake);
		const two = leasePrintWake(settings, printWake);
		expect(one).toBeFunction();
		expect(two).toBeFunction();
		expect(own(settings)).toBe(true);
		one?.();
		one?.();
		expect(printWake.get(settings)).toBe(true);
		two?.();
		expect(own(settings)).toBe(prior);
		expect(printWake.get(settings)).toBe(false);
	}
});

test("a print-wake lease does not edit existing true, later overrides, or persisted values", () => {
	const explicit = Settings.isolated({ "async.printWake": true });
	expect(leasePrintWake(explicit, printWake)).toBeUndefined();
	expect(own(explicit)).toBe(true);
	const settings = Settings.isolated();
	const release = leasePrintWake(settings, printWake);
	printWake.override(settings, false);
	release?.();
	expect(own(settings)).toBe(false);
	printWake.clearOverride(settings);
	const releaseAgain = leasePrintWake(settings, printWake);
	printWake.set(settings, true);
	releaseAgain?.();
	expect(own(settings)).toBeUndefined();
	expect(printWake.get(settings)).toBe(true);
});
