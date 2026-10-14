'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { SessionStore } = require('./session-store');
const { parseJson, validateJoin, validateInput, safeSend } = require('./protocol');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const WEB_ROOT = path.join(PROJECT_ROOT, 'web');
const MAX_MESSAGES_PER_SECOND = 45;
const JOIN_TIMEOUT_MS = 5000;

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const found = [];
  for (const [name, records] of Object.entries(interfaces)) {
    for (const item of records || []) {
      if (item && item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.')) {
        found.push({ interface: name, address: item.address });
      }
    }
  }
  // Prefer conventional Wi-Fi/LAN IPv4 ranges over virtual adapter addresses.
  found.sort((a, b) => {
    const score = (value) => (value.startsWith('192.168.') ? 0 : value.startsWith('10.') ? 1 : value.startsWith('172.') ? 2 : 3);
    return score(a.address) - score(b.address);
  });
  return found;
}

function createApplication({ ttlMs, now, makeCode } = {}) {
  const app = express();
  const sessions = new SessionStore({ ttlMs, now, makeCode });

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  app.use(express.json({ limit: '2kb', strict: true }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'motiondrive', timestamp: Date.now() });
  });

  app.get('/api/network', (_req, res) => {
    res.json({ addresses: getLanAddresses(), port: Number(process.env.PORT) || 3000 });
  });

  app.post('/api/sessions', (_req, res) => {
    try {
      const session = sessions.create();
      res.status(201).json({ code: session.code, createdAt: session.createdAt, expiresInMs: sessions.ttlMs });
    } catch {
      res.status(503).json({ error: 'Could not create a room. Please try again.' });
    }
  });

  app.get('/api/sessions/:code', (req, res) => {
    const session = sessions.get(req.params.code);
    if (!session) return res.status(404).json({ error: 'Room not found or expired.' });
    sessions.touch(session);
    return res.json({ code: session.code, gameConnected: Boolean(session.game && session.game.readyState === WebSocket.OPEN), controllerConnected: Boolean(session.controller && session.controller.readyState === WebSocket.OPEN) });
  });

  app.use(express.static(WEB_ROOT, { extensions: ['html'], maxAge: '1h' }));
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
    return res.status(404).send('Not found');
  });

  return { app, sessions };
}

function createMotionDriveServer(options = {}) {
  const { app, sessions } = createApplication(options);
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  const metadata = new WeakMap();

  function peerState(session, role, connected) {
    const otherRole = role === 'game' ? 'controller' : 'game';
    safeSend(session[otherRole], { type: 'peer', role, connected, timestamp: Date.now() });
    safeSend(session[role], { type: 'peer', role: otherRole, connected: Boolean(session[otherRole] && session[otherRole].readyState === WebSocket.OPEN), timestamp: Date.now() });
  }

  function reject(socket, reason, closeCode = 1008) {
    safeSend(socket, { type: 'error', message: reason });
    try { socket.close(closeCode, 'Invalid request'); } catch { socket.terminate(); }
  }

  server.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  wss.on('connection', (socket) => {
    const meta = { joined: false, session: null, role: null, messageWindowAt: Date.now(), messageCount: 0, alive: true };
    metadata.set(socket, meta);
    socket.on('pong', () => { meta.alive = true; });
    const joinTimeout = setTimeout(() => {
      if (!meta.joined && socket.readyState === WebSocket.OPEN) reject(socket, 'Join timed out.');
    }, JOIN_TIMEOUT_MS);
    joinTimeout.unref?.();

    socket.on('message', (raw) => {
      const now = Date.now();
      if (now - meta.messageWindowAt >= 1000) {
        meta.messageWindowAt = now;
        meta.messageCount = 0;
      }
      meta.messageCount += 1;
      if (meta.messageCount > MAX_MESSAGES_PER_SECOND) {
        reject(socket, 'Message rate too high.', 1008);
        return;
      }
      if (raw.length > 2048) {
        reject(socket, 'Message too large.');
        return;
      }
      const message = parseJson(raw);
      if (!message) {
        reject(socket, 'Malformed JSON.');
        return;
      }

      if (!meta.joined) {
        const join = validateJoin(message);
        if (!join.ok) {
          reject(socket, join.reason);
          return;
        }
        const session = sessions.get(join.code);
        if (!session) {
          reject(socket, 'Room not found or expired.', 1008);
          return;
        }
        const oldSocket = session[join.role];
        if (oldSocket && oldSocket !== socket && oldSocket.readyState === WebSocket.OPEN) {
          safeSend(oldSocket, { type: 'replaced', message: 'Another connection took over this role.' });
          oldSocket.close(4001, 'Connection replaced');
        }
        meta.joined = true;
        meta.session = session;
        meta.role = join.role;
        session[join.role] = socket;
        sessions.touch(session);
        clearTimeout(joinTimeout);
        safeSend(socket, {
          type: 'joined', role: join.role, code: join.code,
          peerConnected: Boolean(session[join.role === 'game' ? 'controller' : 'game'] && session[join.role === 'game' ? 'controller' : 'game'].readyState === WebSocket.OPEN),
          serverTime: Date.now(),
        });
        peerState(session, join.role, true);
        if (join.role === 'game') safeSend(socket, { type: 'input', ...session.lastInput, seq: 0, clientTime: Date.now(), receivedAt: Date.now() });
        return;
      }

      const session = meta.session;
      sessions.touch(session);
      if (meta.role === 'controller') {
        const input = validateInput(message);
        if (input) {
          session.lastInput = { steer: input.steer, throttle: input.throttle, boost: input.boost };
          safeSend(session.game, { ...input, receivedAt: Date.now() });
          safeSend(socket, { type: 'ack', seq: input.seq, clientTime: input.clientTime, serverTime: Date.now() });
          return;
        }
      }
      if (message.type === 'ping') {
        safeSend(socket, { type: 'pong', clientTime: Number.isFinite(message.clientTime) ? message.clientTime : null, serverTime: Date.now() });
        return;
      }
      if (meta.role === 'game' && message.type === 'reset') {
        session.lastInput = { steer: 0, throttle: 0, boost: false };
        safeSend(session.controller, { type: 'game-reset', timestamp: Date.now() });
        return;
      }
      reject(socket, 'Unsupported message.');
    });

    socket.on('close', () => {
      clearTimeout(joinTimeout);
      const { session, role } = meta;
      if (!session || !role) return;
      if (session[role] === socket) {
        session[role] = null;
        session.lastInput = { steer: 0, throttle: 0, boost: false };
        peerState(session, role, false);
      }
      sessions.touch(session);
    });

    socket.on('error', () => {
      // The close handler owns connection-state cleanup; avoid leaking network errors to clients.
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const meta = metadata.get(socket);
      if (!meta) continue;
      if (!meta.alive) {
        socket.terminate();
        continue;
      }
      meta.alive = false;
      try { socket.ping(); } catch { socket.terminate(); }
    }
    sessions.prune();
  }, 30_000);
  heartbeat.unref?.();

  return {
    app,
    server,
    wss,
    sessions,
    async close() {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
      if (server.listening) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    },
  };
}

module.exports = { createApplication, createMotionDriveServer, getLanAddresses };
