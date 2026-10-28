import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(join(here, '..', 'client', 'client.js'), 'utf8');

test('client bundle registers a settings section with the host module loader contract', () => {
  let loaded;
  const window = {
    __ModuleLoader__: {
      load(info) {
        loaded = info;
      },
    },
  };
  const react = {
    createElement: () => null,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: () => [],
    useCallback: (fn) => fn,
    useRef: () => ({ current: undefined }),
  };
  new Function('window', source)(window);
  assert.equal(loaded.id, 'dsh-remote');
  const module = loaded.factory((name) => {
    if (name === 'react') return react;
    throw new Error(`unexpected require: ${name}`);
  });
  assert.equal(module.name, 'dsh-remote');
  assert.deepEqual(module.inject, ['slots', 'locale']);

  const sections = [];
  const injected = [];
  let dictionaries;
  const ctx = {
    effect(fn) {
      return fn();
    },
    locale: {
      register(namespace, value) {
        dictionaries = { namespace, value };
        return () => {};
      },
      bind() {
        return (key) => key;
      },
    },
    slots: {
      inject(name, generator) {
        injected.push(name);
        const iterator = generator();
        let next = iterator.next();
        while (!next.done) next = iterator.next();
      },
      register(spec) {
        sections.push(spec);
        return () => {};
      },
    },
  };
  module.apply(ctx);
  assert.equal(dictionaries.namespace, 'dsh-remote');
  assert.ok(dictionaries.value.zh.nav);
  assert.deepEqual(injected, ['settings.section', 'sidebar.panellist', 'sidebar.panellist']);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].name, 'settings.section');
  assert.equal(sections[0].id, 'remote-config');
  assert.equal(sections[0].order, 35);
  assert.equal(sections[0].label(), 'nav');
  assert.deepEqual(Object.keys(sections[0].inject()), ['t']);

  assert.equal(sections[1].name, 'main');
  assert.equal(sections[1].key, 'dsh-remote');
  assert.deepEqual(Object.keys(sections[1].inject()), ['t']);

  assert.equal(sections[2].name, 'sidebar.panellist');
  assert.equal(sections[2].id, 'dsh-remote');
  assert.equal(sections[2].order, 3);
  assert.equal(sections[2].label(), 'nav');
});

test('renders the sidebar page with explicit server configuration', () => {
  let loaded;
  const nodes = [];
  let cursor = 0;
  const sample = {
    id: 'prod', name: 'prod', host: '10.0.0.10', port: 22, username: 'root',
    authType: 'password', hasPassword: true, hasPassphrase: false, privateKeyPath: '',
    useAgent: false, workdir: '/srv/app', description: '生产', tags: ['web'],
    disabled: false, readyTimeoutMs: 20000, keepaliveIntervalMs: 15000,
    maxOutputBytes: 262144, jump: null,
    createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z',
  };
  const draft = {
    id: 'prod', name: 'prod', host: '10.0.0.10', port: 22, username: 'root',
    authType: 'password', password: '', privateKeyPath: '', passphrase: '', useAgent: false,
    workdir: '/srv/app', description: '生产', tagsText: 'web', disabled: false,
    hasPassword: true, hasPassphrase: false, clearPassword: false, clearPassphrase: false,
    jumpEnabled: false, hadJump: false, jumpHost: '', jumpPort: 22, jumpUsername: '',
    jumpPassword: '', jumpPrivateKeyPath: '', jumpPassphrase: '',
    readyTimeoutMs: '', keepaliveIntervalMs: '', maxOutputBytes: '',
  };
  const state = [
    [sample], '/tmp/servers.json', [], false, '', draft, '', false, {}, 'prod', '', false, '', null, true, false,
  ];
  const h = (type, props, ...children) => {
    const node = { type, props, children };
    nodes.push(node);
    return node;
  };
  const react = {
    createElement: h,
    useState: () => [state[cursor++], () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  };
  const document = {
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { appendChild() {} },
  };
  const window = {
    __ModuleLoader__: { load(info) { loaded = info; } },
    document,
  };
  new Function('window', 'document', source)(window, document);
  let component;
  let main;
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (_name, generator) => {
        const iterator = generator();
        let next = iterator.next();
        while (!next.done) next = iterator.next();
      },
      register(spec, view) {
        if (spec.name === 'settings.section') component = view;
        if (spec.name === 'main') main = view;
        return () => {};
      },
    },
  };
  const module = loaded.factory((name) => {
    if (name === 'react') return react;
    throw new Error(`unexpected require: ${name}`);
  });
  module.apply(ctx);
  assert.equal(typeof component, 'function');
  assert.equal(typeof main, 'function');
  const tree = component({ t: (key) => key });
  assert.equal(tree.type, 'div');
  assert.ok(nodes.some((node) => node.props?.className === 'dsh-remote__fields'), 'renders the explicit details list');
  assert.ok(nodes.some((node) => node.type === 'pre'), 'renders the JSON preview');
  assert.ok(nodes.some((node) => node.type === 'details'));
  assert.ok(nodes.some((node) => node.type === 'button' && node.children[0] === 'save'), 'renders the explicit editor');
  assert.ok(nodes.some((node) => node.type === 'input' && node.props?.type === 'checkbox'));
  // Render the sidebar wrapper too: it must mount the same section.
  const page = main({ t: (key) => key });
  assert.equal(page.type, 'div');
});
