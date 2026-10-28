import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRemoteCommand } from '../src/ssh.js';

test('quotes workdir and environment values as single shell words', () => {
  const command = buildRemoteCommand({
    command: 'printf "%s" "$A"',
    workdir: "/var/www/a b'c",
    env: { A: "x'y", B: 'plain value' },
  });
  assert.equal(command, [
    `cd -- '/var/www/a b'\\''c'`,
    `export A='x'\\''y'`,
    `export B='plain value'`,
    'printf "%s" "$A"',
  ].join('\n'));
});

test('wraps login shell and sudo around the whole script', () => {
  const command = buildRemoteCommand({
    command: 'whoami',
    workdir: '/srv',
    env: { X: '1' },
    loginShell: true,
    sudo: true,
  });
  assert.ok(command.startsWith("sudo -S -p '' sh -c '"), command);
  assert.ok(command.includes("bash -lc '"), command);
  assert.ok(command.includes('/srv'), command);
  assert.ok(command.includes('whoami'), command);
});

test('rejects invalid environment variable names', () => {
  assert.throws(
    () => buildRemoteCommand({ command: 'true', env: { 'bad-name': 'x' } }),
    (error) => error.code === 'invalid-field',
  );
});

test('omits workdir and env when not requested', () => {
  assert.equal(buildRemoteCommand({ command: 'uptime' }), 'uptime');
});
