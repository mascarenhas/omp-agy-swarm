import type { Settings } from "@oh-my-pi/pi-coding-agent";

interface PrintWakeSetting {
	get(settings: Settings): boolean;
	override(settings: Settings, value: boolean): void;
	clearOverride(settings: Settings): void;
}

const leases = new WeakMap<Settings, { holders: number; prior: boolean | undefined }>();

function ownPrintWake(settings: Settings): boolean | undefined {
	const layer = settings.overlayLayers().overrides.async as { printWake?: boolean } | undefined;
	return layer?.printWake;
}

/** Temporarily enable Main's native print wake without mutating operator config. */
export function leasePrintWake(settings: Settings, setting: PrintWakeSetting): (() => void) | undefined {
	let lease = leases.get(settings);
	if (lease) lease.holders++;
	else {
		if (setting.get(settings)) return;
		lease = { holders: 1, prior: ownPrintWake(settings) };
		leases.set(settings, lease);
		try { setting.override(settings, true); } catch (err) {
			leases.delete(settings);
			throw err;
		}
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (--lease.holders !== 0) return;
		leases.delete(settings);
		if (ownPrintWake(settings) !== true) return;
		if (lease.prior === undefined) setting.clearOverride(settings);
		else setting.override(settings, lease.prior);
	};
}
