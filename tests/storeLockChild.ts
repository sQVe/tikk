import { acquireStoreLock } from '../src/store/store.ts';
import { nodeStoreLock } from '../src/store/storeHarness.ts';

const [root, holdText] = process.argv.slice(2);

if (root === undefined || holdText === undefined) {
  process.stderr.write('usage: storeLockChild.ts <store> <holdMilliseconds>\n');
  process.exit(2);
}

const lock = await acquireStoreLock(nodeStoreLock, { root });

if (!lock.ok) {
  process.stderr.write(`${lock.reason.message}\n`);
  process.exit(1);
}

const start = Date.now();

await Bun.sleep(Number(holdText));

const end = Date.now();

await lock.value.release();
process.stdout.write(`${JSON.stringify({ start, end })}\n`);
