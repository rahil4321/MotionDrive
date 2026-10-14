'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJson, validateJoin, validateInput } = require('../src/protocol');

test('protocol parses valid JSON and safely handles malformed payloads', () => {
  assert.deepEqual(parseJson(Buffer.from('{"type":"ping"}')), { type: 'ping' });
  assert.equal(parseJson(Buffer.from('{broken')), null);
});

test('join accepts only supported roles and six-digit room codes', () => {
  assert.deepEqual(validateJoin({ type: 'join', role: 'game', code: '123456' }), { ok: true, role: 'game', code: '123456' });
  assert.equal(validateJoin({ type: 'join', role: 'admin', code: '123456' }).ok, false);
  assert.equal(validateJoin({ type: 'join', role: 'controller', code: '12AB56' }).ok, false);
  assert.equal(validateJoin({ type: 'input', role: 'controller', code: '123456' }).ok, false);
});

test('input clamps out-of-range axes and normalizes booleans', () => {
  assert.deepEqual(validateInput({ type: 'input', steer: 12, throttle: -3, boost: 1, seq: 7, clientTime: 100 }), {
    type: 'input', steer: 1, throttle: -1, boost: false, seq: 7, clientTime: 100,
  });
  assert.equal(validateInput({ type: 'input', steer: 'NaN', throttle: 0, boost: false, seq: 1, clientTime: 100 }), null);
  assert.equal(validateInput({ type: 'input', steer: '0.5', throttle: 0, boost: false, seq: 1, clientTime: 100 }), null);
  assert.equal(validateInput({ type: 'input', steer: 0, throttle: 0, boost: false, seq: '1', clientTime: 100 }), null);
  assert.equal(validateInput({ type: 'input', steer: 0, throttle: 0, boost: false, seq: -1, clientTime: 100 }), null);
  assert.equal(validateInput({ type: 'input', steer: 0, throttle: 0, boost: false, seq: 1, clientTime: 0 }), null);
  assert.equal(validateInput({ type: 'ping' }), null);
});
