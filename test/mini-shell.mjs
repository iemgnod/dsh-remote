/**
 * Minimal POSIX-ish interpreter for the test SSH server. It understands only
 * the command shapes this plugin emits, without spawning a real shell (the DSH
 * sandbox refuses piped child stdio, and portable Git Bash cannot start under
 * the Windows job object).
 */

import path from 'node:path';

/**
 * @param {string} script
 * @param {{ cwd: string, env: Record<string, string | undefined>, username: string, cancelled: () => boolean }} options
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
export async function runScript(script, options) {
  let text = script.trim();
  const wrapper = /^(?:bash -lc|sudo -S -p '' sh -c) ('(?:[^']|'\\'')*')$/.exec(text);
  if (wrapper) return runScript(posixUnquote(wrapper[1]), options);
  if (text.includes('DSH_REMOTE_OK')) {
    return {
      stdout: `DSH_REMOTE_OK\n${options.username}\nlinux-test x86_64\n${options.cwd}\n`,
      stderr: '',
      code: 0,
    };
  }
  let stdout = '';
  let stderr = '';
  let code = 0;
  const cwdRef = { value: options.cwd };
  options.env = { ...options.env, PWD: cwdRef.value };
  for (const rawLine of text.split('\n')) {
    if (options.cancelled()) break;
    for (const rawCommand of splitTopLevel(rawLine, ';')) {
      const command = rawCommand.trim();
      if (!command || command.startsWith('#')) continue;
      const redirect = /(?:>>?&\s*2|1>&2|2>&1)\s*$/.exec(command);
      const toStderr = redirect !== null;
      const body = redirect ? command.slice(0, redirect.index).trim() : command;
      const tokens = tokenize(body, options.env);
      if (tokens.length === 0) continue;
      const [head, ...args] = tokens;
      let output = '';
      let failure = 0;
      if (head === 'exit') {
        code = Number(args[0] ?? 0) || 0;
        return { stdout, stderr, code };
      } else if (head === 'sleep') {
        const ms = Math.max(0, Number(args[0] ?? 0)) * 1000;
        const until = Date.now() + ms;
        while (Date.now() < until) {
          if (options.cancelled()) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } else if (head === 'cd') {
        const target = args[0] === '--' ? args.slice(1).join(' ') : args.join(' ');
        if (!target) cwdRef.value = '/';
        else if (target.startsWith('/')) cwdRef.value = path.join(options.cwd, target.slice(1));
        else cwdRef.value = path.resolve(cwdRef.value, target);
        options.env.PWD = cwdRef.value;
      } else if (head === 'export') {
        for (const assignment of args) {
          const index = assignment.indexOf('=');
          if (index > 0) options.env[assignment.slice(0, index)] = assignment.slice(index + 1);
        }
      } else if (head === 'printf') {
        output = formatPrintf(args[0] ?? '', args.slice(1));
      } else if (head === 'echo') {
        output = args.join(' ') + '\n';
      } else if (head === 'pwd') {
        output = cwdRef.value + '\n';
      } else if (head === 'true' || head === ':') {
        // no-op
      } else if (head === 'basename') {
        output = path.basename(args[0] ?? '') + '\n';
      } else if (head === 'id' || head === 'whoami') {
        output = options.username + '\n';
      } else if (head === 'uname') {
        output = 'linux-test x86_64\n';
      } else {
        stderr += `test-ssh: command not interpreted: ${head}\n`;
        failure = 127;
      }
      if (toStderr) stderr += output;
      else stdout += output;
      if (failure !== 0) code = failure;
    }
  }
  return { stdout, stderr, code };
}

/** Split on a delimiter outside quotes. */
function splitTopLevel(input, delimiter) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === delimiter) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** POSIX single-quote decoding. */
export function posixUnquote(token) {
  if (!token.startsWith("'") || !token.endsWith("'")) return token;
  return token.slice(1, -1).split("'\\''").join("'");
}

/** Word splitting with quote state and `$NAME` expansion. */
function tokenize(input, env) {
  const tokens = [];
  let current = '';
  let started = false;
  let quote = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === '\\' && index + 1 < input.length) {
        current += input[index + 1];
        index += 1;
      } else if (char === '$') {
        const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(input.slice(index));
        if (match) {
          current += env[match[1] ?? match[2]] ?? '';
          index += match[0].length - 1;
        } else {
          current += char;
        }
      } else {
        current += char;
      }
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === '\\' && index + 1 < input.length) {
      current += input[index + 1];
      index += 1;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(expand(current, env));
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(expand(current, env));
  return tokens;
}

function expand(text, env) {
  return text.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_match, braced, plain) => env[braced ?? plain] ?? '');
}

/** printf subset used by the tests and the probe. */
function formatPrintf(format, args) {
  let output = '';
  let argIndex = 0;
  for (let index = 0; index < format.length; index += 1) {
    const char = format[index];
    if (char === '\\' && index + 1 < format.length) {
      const next = format[index + 1];
      output += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
      index += 1;
      continue;
    }
    if (char === '%' && index + 1 < format.length) {
      const next = format[index + 1];
      if (next === 's' || next === 'd') {
        output += args[argIndex] ?? '';
        argIndex += 1;
        index += 1;
        continue;
      }
      if (next === '%') {
        output += '%';
        index += 1;
        continue;
      }
    }
    output += char;
  }
  return output;
}
