'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionStore } = require('../src/session-store');

test('session store creates unique six-digit codes', () => {
  const codes = ['111111', '222222'];
  const store = new SessionStore({ makeCode: () => codes.shift() });
  const first = store.create();
  const second = store.create();
  assert.equal(first.code, '111111');
  assert.equal(second.code, '222222');
  assert.equal(store.size, 2);
});

test('session store rejects duplicate codes without looping forever', () => {
  const store = new SessionStore({ makeCode: () => '123456' });
  store.create();
  assert.throws(() => store.create(), /Unable to allocate/);
});

test('session store refreshes room activity and expires inactive rooms', () => {
  let now = 1_000;
  const store = new SessionStore({ ttlMs: 500, now: () => now, makeCode: () => '456789' });
  const session = store.create();
  now = 1_400;
  store.touch(session);
  now = 1_850;
  assert.equal(store.get('456789'), session);
  now = 2_000;
  assert.equal(store.get('456789'), null);
  assert.equal(store.size, 0);
});

test('session store rejects malformed room codes', () => {
  const store = new SessionStore({ makeCode: () => '123456' });
  store.create();
  for (const code of ['', '12345', '1234567', 'abcdef', '../123456']) assert.equal(store.get(code), null);
});
