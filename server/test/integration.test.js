'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createMotionDriveServer } = require('../src/create-server');

class Inbox {
  constructor(socket) {
    this.messages = [];
    this.waiters = [];
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString('utf8')); } catch { return; }
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }
  waitFor(predicate, timeoutMs = 1500) {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error('Timed out waiting for WebSocket message'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

async function waitOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

async function joinClient(url, role, code) {
  const socket = new WebSocket(url);
  const inbox = new Inbox(socket);
  await waitOpen(socket);
  socket.send(JSON.stringify({ type: 'join', role, code }));
  return { socket, inbox, joined: await inbox.waitFor((message) => message.type === 'joined') };
}

test('HTTP and WebSocket integration: create room, pair roles, validate and forward input', async (t) => {
  const application = createMotionDriveServer({ makeCode: () => '345678' });
  await new Promise((resolve, reject) => {
    application.server.once('error', reject);
    application.server.listen(0, '127.0.0.1', resolve);
  });
  const port = application.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await application.close();
  });

  const healthResponse = await fetch(`${base}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual((await healthResponse.json()).status, 'ok');
  assert.equal(healthResponse.headers.get('x-content-type-options'), 'nosniff');

  const pageResponse = await fetch(`${base}/`);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /MotionDrive/);

  const createResponse = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(createResponse.status, 201);
  assert.equal((await createResponse.json()).code, '345678');
  const missingRoom = await fetch(`${base}/api/sessions/000000`);
  assert.equal(missingRoom.status, 404);

  const game = await joinClient(wsUrl, 'game', '345678');
  sockets.push(game.socket);
  assert.equal(game.joined.role, 'game');
  const controller = await joinClient(wsUrl, 'controller', '345678');
  sockets.push(controller.socket);
  assert.equal(controller.joined.role, 'controller');
  assert.equal(controller.joined.peerConnected, true);
  await game.inbox.waitFor((message) => message.type === 'peer' && message.role === 'controller' && message.connected === true);

  controller.socket.send(JSON.stringify({ type: 'input', steer: 3.25, throttle: -5, boost: true, seq: 42, clientTime: Date.now() }));
  const forwarded = await game.inbox.waitFor((message) => message.type === 'input' && message.seq === 42);
  assert.equal(forwarded.steer, 1);
  assert.equal(forwarded.throttle, -1);
  assert.equal(forwarded.boost, true);
  const ack = await controller.inbox.waitFor((message) => message.type === 'ack' && message.seq === 42);
  assert.equal(ack.clientTime > 0, true);
  assert.equal(Number.isFinite(ack.serverTime), true);

  controller.socket.send(JSON.stringify({ type: 'input', steer: 'invalid', throttle: 0, boost: false, seq: 43, clientTime: Date.now() }));
  const error = await controller.inbox.waitFor((message) => message.type === 'error');
  assert.match(error.message, /Unsupported/);
});

test('WebSocket rejects attempts to join a missing room', async (t) => {
  const application = createMotionDriveServer();
  await new Promise((resolve, reject) => {
    application.server.once('error', reject);
    application.server.listen(0, '127.0.0.1', resolve);
  });
  const socket = new WebSocket(`ws://127.0.0.1:${application.server.address().port}/ws`);
  const inbox = new Inbox(socket);
  t.after(async () => { try { socket.terminate(); } catch { /* no-op */ } await application.close(); });
  await waitOpen(socket);
  socket.send(JSON.stringify({ type: 'join', role: 'controller', code: '000000' }));
  const error = await inbox.waitFor((message) => message.type === 'error');
  assert.match(error.message, /not found/);
});
