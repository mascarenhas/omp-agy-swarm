// Child process for the lease race test: tries to take the lease on argv[2] as session argv[3],
// prints "won" or "lost: <reason>", and holds a won lease until stdin closes or 2 s pass.

import { acquireLease } from "../../src/board/lock.ts";

const [dir, sid] = process.argv.slice(2);
try {
	const lease = acquireLease(dir as string, sid as string);
	lease.commitOwner();
	process.stdout.write("won\n");
	await Bun.sleep(Number(process.env.HOLD_MS ?? 600));
	lease.release();
} catch (err) {
	process.stdout.write(`lost: ${(err as Error).message}\n`);
}
