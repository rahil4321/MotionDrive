'use strict';

const crypto = require('node:crypto');

const CODE_PATTERN = /^\d{6}$/;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

class SessionStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now(), makeCode } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.makeCode = makeCode || (() => String(100000 + crypto.randomInt(0, 900000)));
    this.sessions = new Map();
  }

  create() {
    // Bound the loop so a broken injected code generator cannot hang the process.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = this.makeCode();
      if (!CODE_PATTERN.test(code) || this.sessions.has(code)) continue;
      const now = this.now();
      const session = {
        code,
        createdAt: now,
        lastSeenAt: now,
        game: null,
        controller: null,
        lastInput: { steer: 0, throttle: 0, boost: false },
      };
      this.sessions.set(code, session);
      return session;
    }
    throw new Error('Unable to allocate a unique session code');
  }

  get(code) {
    if (!CODE_PATTERN.test(String(code || ''))) return null;
    const session = this.sessions.get(code);
    if (!session) return null;
    if (this.now() - session.lastSeenAt > this.ttlMs) {
      this.sessions.delete(code);
      return null;
    }
    return session;
  }

  touch(session) {
    if (session && this.sessions.get(session.code) === session) {
      session.lastSeenAt = this.now();
    }
  }

  prune() {
    const now = this.now();
    for (const [code, session] of this.sessions) {
      if (now - session.lastSeenAt > this.ttlMs) {
        this.sessions.delete(code);
      }
    }
  }

  get size() {
    return this.sessions.size;
  }
}

module.exports = { SessionStore, CODE_PATTERN, DEFAULT_TTL_MS };
