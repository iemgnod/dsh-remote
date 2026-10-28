/** In-process test entry: `node --test` spawns files with piped stdio, which the DSH Windows sandbox refuses. */
await import('./store.test.mjs');
await import('./command.test.mjs');
await import('./ssh.test.mjs');
await import('./routes.test.mjs');
await import('./tools.test.mjs');
await import('./apply.test.mjs');
await import('./client.test.mjs');
