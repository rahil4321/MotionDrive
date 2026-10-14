'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('gameCanvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const ui = {
    serverDot: $('serverDot'), serverStatus: $('serverStatus'), gameLinkBadge: $('gameLinkBadge'),
    roomCode: $('roomCode'), roomStatus: $('roomStatus'), serverAddress: $('serverAddress'),
    controllerStatus: $('controllerStatus'), connectionHint: $('connectionHint'), notice: $('notice'),
    score: $('scoreValue'), distance: $('distanceValue'), lives: $('livesValue'), speed: $('speedValue'),
    canvasOverlay: $('canvasOverlay'), runEnded: $('runEnded'), finalScore: $('finalScore'),
  };
  const state = {
    roomCode: null, socket: null, shouldReconnect: true, reconnectTimer: null, reconnectDelay: 900,
    serverOk: false, gameOpen: false, controllerOpen: false, lastInputAt: 0,
    steer: 0, throttle: 0, remoteBoost: false, previousBoost: false, localBoost: false,
    boostUntil: 0, playerLane: 0, obstacles: [], particles: [], lastSpawn: 0, lastFrame: 0,
    elapsed: 0, distance: 0, score: 0, lives: 3, invulnerableUntil: 0, gameOver: false,
    screenWidth: 900, screenHeight: 520, dpr: 1, keys: new Set(), lastHudUpdate: 0,
    highScore: 0,
  };
  try { state.highScore = Number(localStorage.getItem('motiondrive.highScore') || 0); } catch { /* storage may be disabled */ }

  function setNotice(message) { ui.notice.textContent = message || ''; }
  function setDot(el, status) { el.classList.toggle('ok', status === 'ok'); el.classList.toggle('bad', status === 'bad'); }
  function setServerStatus(healthy, message) {
    state.serverOk = healthy;
    setDot(ui.serverDot, healthy ? 'ok' : 'bad');
    ui.serverStatus.textContent = message;
  }
  function setGameLink(connected) {
    state.gameOpen = connected;
    ui.gameLinkBadge.textContent = connected ? 'GAME LINKED' : 'GAME LINKING';
    ui.gameLinkBadge.classList.toggle('live', connected);
    ui.roomStatus.textContent = connected ? 'Room is live and ready.' : 'Connecting to local server…';
  }
  function setControllerLink(connected) {
    state.controllerOpen = connected;
    ui.controllerStatus.textContent = connected ? 'Phone connected' : 'Waiting for phone';
    ui.connectionHint.textContent = connected ? 'Motion packets are arriving over WebSocket.' : 'Open the app and tap Connect.';
    if (connected) ui.canvasOverlay.classList.add('hidden');
    else if (!state.gameOver) ui.canvasOverlay.classList.remove('hidden');
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  async function refreshNetworkAddress() {
    try {
      const data = await api('/api/network');
      const addresses = Array.isArray(data.addresses) ? data.addresses : [];
      if (addresses.length) {
        ui.serverAddress.textContent = `${addresses[0].address}:${data.port || 3000}`;
        ui.serverAddress.title = addresses.map((item) => `${item.interface}: ${item.address}`).join('\n');
      } else {
        ui.serverAddress.textContent = `localhost:${data.port || 3000}`;
      }
    } catch {
      ui.serverAddress.textContent = 'Server address unavailable';
    }
  }

  function closeGameSocket() {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    if (state.socket) {
      state.socket.onclose = null;
      try { state.socket.close(); } catch { /* no-op */ }
      state.socket = null;
    }
  }

  function connectGameSocket() {
    if (!state.roomCode || !state.shouldReconnect) return;
    closeGameSocket();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    try { socket = new WebSocket(`${protocol}//${window.location.host}/ws`); }
    catch { scheduleReconnect(); return; }
    state.socket = socket;
    socket.addEventListener('open', () => {
      if (state.socket !== socket) return;
      state.reconnectDelay = 900;
      socket.send(JSON.stringify({ type: 'join', role: 'game', code: state.roomCode }));
    });
    socket.addEventListener('message', (event) => {
      if (state.socket !== socket) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'joined') {
        setGameLink(true);
        setServerStatus(true, 'Local server online');
      } else if (message.type === 'peer') {
        if (message.role === 'controller') setControllerLink(Boolean(message.connected));
      } else if (message.type === 'input') {
        state.lastInputAt = Date.now();
        state.steer = clamp(Number(message.steer) || 0, -1, 1);
        state.throttle = clamp(Number(message.throttle) || 0, -1, 1);
        state.remoteBoost = message.boost === true;
      } else if (message.type === 'error') {
        setNotice(message.message || 'Could not join the room. Generate a new one.');
        state.shouldReconnect = false;
        closeGameSocket();
        setGameLink(false);
      } else if (message.type === 'replaced') {
        setNotice(message.message || 'This game room was opened in another tab.');
      }
    });
    socket.addEventListener('close', () => {
      if (state.socket !== socket) return;
      state.socket = null;
      setGameLink(false);
      if (state.shouldReconnect) scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      if (state.socket !== socket) return;
      setServerStatus(false, 'Server connection interrupted');
    });
  }

  function scheduleReconnect() {
    if (!state.shouldReconnect || state.reconnectTimer) return;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      state.reconnectDelay = Math.min(5000, Math.round(state.reconnectDelay * 1.4));
      connectGameSocket();
    }, state.reconnectDelay);
  }

  async function createRoom() {
    setNotice('');
    state.shouldReconnect = false;
    closeGameSocket();
    setControllerLink(false);
    setGameLink(false);
    try {
      setServerStatus(true, 'Creating room…');
      const data = await api('/api/sessions', { method: 'POST', body: '{}' });
      state.roomCode = data.code;
      const codeText = document.createElement('span');
      codeText.textContent = data.code;
      ui.roomCode.replaceChildren(codeText, ui.roomCode.querySelector('button'));
      state.shouldReconnect = true;
      resetRun();
      connectGameSocket();
      setServerStatus(true, 'Local server online');
    } catch (error) {
      setServerStatus(false, 'Server unavailable');
      ui.roomStatus.textContent = 'Room creation failed.';
      setNotice(`${error.message}. Check that the server is running, then refresh.`);
    }
  }

  function resetRun() {
    state.playerLane = 0; state.obstacles = []; state.particles = []; state.lastSpawn = performance.now();
    state.elapsed = 0; state.distance = 0; state.score = 0; state.lives = 3; state.invulnerableUntil = 0;
    state.gameOver = false; state.boostUntil = 0; state.remoteBoost = false; state.previousBoost = false;
    ui.runEnded.hidden = true;
    ui.canvasOverlay.classList.toggle('hidden', state.controllerOpen);
    if (state.socket && state.socket.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: 'reset' }));
    updateHud(true);
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    state.screenWidth = Math.max(1, rect.width);
    state.screenHeight = Math.max(1, rect.height);
    state.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(state.screenWidth * state.dpr);
    canvas.height = Math.round(state.screenHeight * state.dpr);
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  }

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function randomLane() { return [-0.72, 0, 0.72][Math.floor(Math.random() * 3)]; }
  function halfRoadWidth(t) { return state.screenWidth * (0.1 + 0.37 * Math.pow(clamp(t, 0, 1), 1.12)); }
  function roadY(t) { return state.screenHeight * (0.19 + 0.77 * t); }

  function drawBackground(now) {
    const w = state.screenWidth, h = state.screenHeight;
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#080d1c'); sky.addColorStop(.52, '#15142b'); sky.addColorStop(1, '#070b13');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    const glow = ctx.createRadialGradient(w * .5, h * .3, 2, w * .5, h * .3, w * .48);
    glow.addColorStop(0, '#744bff22'); glow.addColorStop(1, '#744bff00');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
    // Fixed star pattern avoids per-frame allocations and noisy flicker.
    for (let i = 0; i < 42; i += 1) {
      const x = ((i * 127.7) % w);
      const y = ((i * 43.3) % (h * .52));
      const twinkle = .3 + .7 * Math.abs(Math.sin(now * .0007 + i));
      ctx.globalAlpha = twinkle * .48; ctx.fillStyle = i % 5 === 0 ? '#5cf6e5' : '#a7b9ee';
      ctx.fillRect(x, y, i % 7 === 0 ? 2 : 1, i % 7 === 0 ? 2 : 1);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#403c6a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h * .2); ctx.lineTo(w, h * .2); ctx.stroke();
    // Distant skyline silhouettes.
    ctx.fillStyle = '#11172b';
    for (let i = 0; i < 22; i += 1) {
      const x = i * w / 20 - 12;
      const bw = w * (.018 + (i % 4) * .008);
      const bh = h * (.035 + ((i * 7) % 13) / 100);
      ctx.fillRect(x, h * .2 - bh, bw, bh);
      if (i % 3 === 0) { ctx.fillStyle = '#7d6cff55'; ctx.fillRect(x + bw * .25, h * .2 - bh * .7, 2, 2); ctx.fillStyle = '#11172b'; }
    }
  }

  function drawRoad() {
    const w = state.screenWidth, h = state.screenHeight;
    const center = w / 2, topY = roadY(0), bottomY = roadY(1);
    ctx.beginPath(); ctx.moveTo(center - halfRoadWidth(0), topY); ctx.lineTo(center + halfRoadWidth(0), topY); ctx.lineTo(center + halfRoadWidth(1), bottomY); ctx.lineTo(center - halfRoadWidth(1), bottomY); ctx.closePath();
    const roadGradient = ctx.createLinearGradient(0, topY, 0, bottomY); roadGradient.addColorStop(0, '#141a2a'); roadGradient.addColorStop(1, '#111827');
    ctx.fillStyle = roadGradient; ctx.fill();
    // Edge rails glow cyan on the left and violet on the right.
    ctx.lineWidth = 2; ctx.strokeStyle = '#5cf6e5'; ctx.shadowColor = '#5cf6e5'; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.moveTo(center - halfRoadWidth(0), topY); ctx.lineTo(center - halfRoadWidth(1), bottomY); ctx.stroke();
    ctx.strokeStyle = '#b28aff'; ctx.shadowColor = '#b28aff';
    ctx.beginPath(); ctx.moveTo(center + halfRoadWidth(0), topY); ctx.lineTo(center + halfRoadWidth(1), bottomY); ctx.stroke(); ctx.shadowBlur = 0;
    // Perspective lane marks move with distance travelled.
    for (const lane of [-.34, .34]) {
      for (let mark = 0; mark < 13; mark += 1) {
        const phase = ((mark / 13 + (state.distance * .045 % 1)) % 1);
        const t = .06 + phase * .9;
        const y = roadY(t); const x = center + lane * halfRoadWidth(t);
        const markH = 2 + 11 * t; const markW = 1 + 2 * t;
        ctx.globalAlpha = .18 + .7 * t; ctx.fillStyle = '#8191b9'; ctx.fillRect(x - markW / 2, y, markW, markH);
      }
    }
    // Subtle horizontal speed streaks.
    ctx.globalAlpha = .18; ctx.strokeStyle = '#4f6784'; ctx.lineWidth = 1;
    for (let i = 0; i < 8; i += 1) {
      const t = ((i / 8 + state.distance * .02) % 1);
      const y = roadY(t); const rw = halfRoadWidth(t) * .8;
      ctx.beginPath(); ctx.moveTo(center - rw, y); ctx.lineTo(center + rw, y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function spawnObstacle(now) {
    if (state.gameOver || now - state.lastSpawn < (state.boostUntil > now ? 800 : 1160)) return;
    state.lastSpawn = now;
    const lanes = [-.72, 0, .72];
    const previous = state.obstacles.length ? state.obstacles[state.obstacles.length - 1].lane : 9;
    let lane = randomLane();
    if (Math.abs(lane - previous) < .1 && Math.random() < .65) lane = lanes[(lanes.indexOf(lane) + 1) % 3];
    state.obstacles.push({ lane, z: 0, type: Math.random() < .18 ? 'energy' : 'barrier', hit: false, hue: Math.random() < .5 ? '#f871b3' : '#a28bff' });
  }

  function drawObstacle(obstacle) {
    const t = obstacle.z; if (t < 0 || t > 1.06) return;
    const w = state.screenWidth, h = state.screenHeight, center = w / 2;
    const x = center + obstacle.lane * halfRoadWidth(t) * .8;
    const y = roadY(t) - 9 - 23 * t;
    const ow = w * (.024 + .065 * t), oh = h * (.013 + .063 * t);
    ctx.save(); ctx.translate(x, y);
    if (obstacle.type === 'energy') {
      ctx.shadowColor = '#5cf6e5'; ctx.shadowBlur = 16;
      ctx.fillStyle = '#5cf6e5'; ctx.beginPath(); ctx.moveTo(0, -oh * .72); ctx.lineTo(ow * .52, 0); ctx.lineTo(0, oh * .72); ctx.lineTo(-ow * .52, 0); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#e0fffb'; ctx.beginPath(); ctx.arc(0, 0, Math.max(2, ow * .1), 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.shadowColor = obstacle.hue; ctx.shadowBlur = 18;
      ctx.fillStyle = '#201b30'; ctx.strokeStyle = obstacle.hue; ctx.lineWidth = Math.max(1, 1.2 * t);
      ctx.beginPath(); ctx.roundRect(-ow / 2, -oh / 2, ow, oh, Math.max(2, 3 * t)); ctx.fill(); ctx.stroke();
      ctx.fillStyle = obstacle.hue; ctx.globalAlpha = .75; ctx.fillRect(-ow * .4, -oh * .1, ow * .8, Math.max(2, oh * .16));
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function drawCar() {
    const w = state.screenWidth, h = state.screenHeight;
    const t = .91, center = w / 2 + state.playerLane * halfRoadWidth(t) * .8;
    const y = roadY(t) - h * .065, carW = w * .055, carH = h * .105;
    if (performance.now() < state.invulnerableUntil && Math.floor(performance.now() / 80) % 2 === 0) return;
    ctx.save(); ctx.translate(center, y);
    const turning = clamp(state.steer, -1, 1) * .11;
    ctx.rotate(-turning);
    ctx.shadowColor = '#5cf6e5'; ctx.shadowBlur = 23;
    ctx.fillStyle = '#5cf6e5'; ctx.beginPath(); ctx.moveTo(-carW * .46, carH * .36); ctx.lineTo(-carW * .36, -carH * .2); ctx.lineTo(-carW * .18, -carH * .5); ctx.lineTo(carW * .18, -carH * .5); ctx.lineTo(carW * .36, -carH * .2); ctx.lineTo(carW * .46, carH * .36); ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = '#152b3a'; ctx.beginPath(); ctx.moveTo(-carW * .23, -carH * .18); ctx.lineTo(-carW * .13, -carH * .39); ctx.lineTo(carW * .13, -carH * .39); ctx.lineTo(carW * .23, -carH * .18); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillRect(-carW * .31, carH * .2, carW * .17, carH * .05); ctx.fillRect(carW * .14, carH * .2, carW * .17, carH * .05);
    ctx.fillStyle = '#f871b3'; ctx.fillRect(-carW * .3, carH * .42, carW * .18, carH * .055); ctx.fillRect(carW * .12, carH * .42, carW * .18, carH * .055);
    if (state.boostUntil > performance.now()) {
      ctx.shadowColor = '#a28bff'; ctx.shadowBlur = 21; ctx.fillStyle = '#a28bff';
      ctx.beginPath(); ctx.moveTo(-carW * .2, carH * .4); ctx.lineTo(-carW * .13, carH * .9); ctx.lineTo(0, carH * .5); ctx.lineTo(carW * .12, carH * .92); ctx.lineTo(carW * .2, carH * .4); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  function addBurst(x, y, color, count = 12) {
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2, speed = 25 + Math.random() * 120;
      state.particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: .35 + Math.random() * .4, age: 0, color });
    }
  }

  function drawParticles(dt) {
    for (const p of state.particles) {
      p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 40 * dt;
      ctx.globalAlpha = Math.max(0, 1 - p.age / p.life); ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, 2.3, 2.3);
    }
    ctx.globalAlpha = 1; state.particles = state.particles.filter((p) => p.age < p.life);
  }

  function endRun() {
    state.gameOver = true;
    ui.finalScore.textContent = `Score: ${Math.floor(state.score).toLocaleString()} · Distance: ${Math.floor(state.distance)} m`;
    ui.runEnded.hidden = false;
    if (state.score > state.highScore) {
      state.highScore = Math.floor(state.score);
      try { localStorage.setItem('motiondrive.highScore', String(state.highScore)); } catch { /* storage may be disabled */ }
    }
  }

  function updateGame(dt, now) {
    const inputFresh = Date.now() - state.lastInputAt < 500;
    let keyboardSteer = 0;
    if (state.keys.has('ArrowLeft') || state.keys.has('a')) keyboardSteer -= 1;
    if (state.keys.has('ArrowRight') || state.keys.has('d')) keyboardSteer += 1;
    const steer = inputFresh ? state.steer : keyboardSteer;
    const throttle = inputFresh ? state.throttle : 0;
    const boost = state.remoteBoost || state.keys.has(' ') || state.localBoost;
    if (boost && !state.previousBoost) {
      state.boostUntil = now + 1000;
      addBurst(state.screenWidth / 2 + state.playerLane * halfRoadWidth(.9) * .8, roadY(.9), '#a28bff', 15);
    }
    state.previousBoost = boost;
    const boostOn = now < state.boostUntil;
    state.steer += (steer - state.steer) * Math.min(1, dt * 11);
    if (!state.gameOver) {
      state.playerLane = clamp(state.playerLane + state.steer * dt * 1.35, -.93, .93);
      const speedFactor = clamp(.92 + throttle * .1 + (boostOn ? .55 : 0), .65, 1.65);
      state.elapsed += dt;
      state.distance += dt * 29 * speedFactor;
      state.score += dt * 28 * speedFactor;
      spawnObstacle(now);
      for (const obstacle of state.obstacles) {
        const oldZ = obstacle.z;
        obstacle.z += dt * (.19 + speedFactor * .09);
        if (!obstacle.hit && oldZ < .89 && obstacle.z >= .89) {
          if (Math.abs(state.playerLane - obstacle.lane) < .43) {
            obstacle.hit = true;
            if (obstacle.type === 'energy') {
              state.score += 150;
              addBurst(state.screenWidth / 2 + obstacle.lane * halfRoadWidth(obstacle.z) * .8, roadY(obstacle.z), '#5cf6e5', 15);
            } else if (now > state.invulnerableUntil) {
              state.lives = Math.max(0, state.lives - 1);
              state.score = Math.max(0, state.score - 100);
              state.invulnerableUntil = now + 1200;
              addBurst(state.screenWidth / 2 + state.playerLane * halfRoadWidth(.9) * .8, roadY(.9), '#f871b3', 20);
              if (state.lives === 0) endRun();
            }
          }
        }
      }
      state.obstacles = state.obstacles.filter((item) => item.z < 1.12);
    }
  }

  function updateHud(force = false) {
    const now = performance.now();
    if (!force && now - state.lastHudUpdate < 100) return;
    state.lastHudUpdate = now;
    ui.score.textContent = String(Math.floor(state.score)).padStart(6, '0');
    ui.distance.innerHTML = `${String(Math.floor(state.distance)).padStart(4, '0')}<span>m</span>`;
    ui.lives.textContent = `${state.lives > 0 ? '◆ '.repeat(state.lives).trim() : '—'}${state.lives < 3 ? ' ' + '◇ '.repeat(3 - state.lives).trim() : ''}`;
    ui.speed.innerHTML = `${Math.round(150 * clamp(.8 + (state.boostUntil > now ? .6 : 0), .7, 1.5))}<span>km/h</span>`;
  }

  function frame(timestamp) {
    const dt = Math.min(.05, state.lastFrame ? (timestamp - state.lastFrame) / 1000 : 0);
    state.lastFrame = timestamp;
    updateGame(dt, timestamp);
    drawBackground(timestamp); drawRoad();
    for (const obstacle of state.obstacles) drawObstacle(obstacle);
    drawCar(); drawParticles(dt); updateHud();
    requestAnimationFrame(frame);
  }

  function copyText(text, message) {
    if (!text) return;
    const fallback = () => {
      const field = document.createElement('textarea'); field.value = text; field.style.position = 'fixed'; field.style.opacity = '0'; document.body.appendChild(field); field.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; } field.remove();
      setNotice(ok ? message : 'Copy failed. Select and copy the text manually.');
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => setNotice(message)).catch(fallback);
    else fallback();
  }

  $('newRoomButton').addEventListener('click', createRoom);
  $('restartButton').addEventListener('click', resetRun);
  $('copyCodeButton').addEventListener('click', () => copyText(state.roomCode, 'Room code copied.'));
  $('copyAddressButton').addEventListener('click', () => copyText(ui.serverAddress.textContent, 'Server address copied.'));
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('keydown', (event) => {
    const key = event.key === ' ' ? ' ' : event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (['ArrowLeft', 'ArrowRight', ' ', 'a', 'd'].includes(key)) event.preventDefault();
    state.keys.add(key);
  });
  window.addEventListener('keyup', (event) => {
    const key = event.key === ' ' ? ' ' : event.key.length === 1 ? event.key.toLowerCase() : event.key;
    state.keys.delete(key);
  });
  window.addEventListener('blur', () => state.keys.clear());

  setServerStatus(false, 'Checking local server…');
  resizeCanvas();
  refreshNetworkAddress();
  api('/api/health').then(() => setServerStatus(true, 'Local server online')).catch(() => {
    setServerStatus(false, 'Server unavailable');
    setNotice('Start the server with npm start, then refresh this page.');
  });
  createRoom();
  requestAnimationFrame(frame);
})();
