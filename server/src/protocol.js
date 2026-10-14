'use strict';

const { CODE_PATTERN } = require('./session-store');

const MAX_STEER = 1;
const MAX_THROTTLE = 1;

function parseJson(raw) {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

function validateJoin(message) {
  if (!message || message.type !== 'join') return { ok: false, reason: 'First message must be a join request.' };
  if (message.role !== 'game' && message.role !== 'controller') {
    return { ok: false, reason: 'Role must be game or controller.' };
  }
  if (typeof message.code !== 'string' || !CODE_PATTERN.test(message.code)) {
    return { ok: false, reason: 'Room code must contain six digits.' };
  }
  return { ok: true, role: message.role, code: message.code };
}

function validateInput(message) {
  if (!message || message.type !== 'input') return null;
  if (typeof message.steer !== 'number' || typeof message.throttle !== 'number') return null;
  if (typeof message.seq !== 'number' || typeof message.clientTime !== 'number') return null;
  const { steer, throttle, seq, clientTime } = message;
  if (!Number.isFinite(steer) || !Number.isFinite(throttle)) return null;
  if (!Number.isSafeInteger(seq) || seq < 0) return null;
  if (!Number.isFinite(clientTime) || clientTime <= 0) return null;
  return {
    type: 'input',
    steer: Math.max(-MAX_STEER, Math.min(MAX_STEER, steer)),
    throttle: Math.max(-MAX_THROTTLE, Math.min(MAX_THROTTLE, throttle)),
    boost: message.boost === true,
    seq,
    clientTime,
  };
}

function safeSend(socket, payload) {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

module.exports = { parseJson, validateJoin, validateInput, safeSend };
