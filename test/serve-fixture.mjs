/** Long-running fixture for manual end-to-end checks against the live plugin. */
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startSshServer } from './ssh-server.mjs';

const port = Number(process.argv[2] ?? 0);
const root = fs.mkdtempSync(join(tmpdir(), 'dsh-remote-fixture-'));
const server = await startSshServer({ port, rootDir: join(root, 'remote') });
console.log(`READY ${server.port} ${root}`);
process.on('SIGTERM', async () => { await server.close(); process.exit(0); });
process.on('SIGINT', async () => { await server.close(); process.exit(0); });
setInterval(() => {}, 60_000);
