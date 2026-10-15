import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { DeviceMotion } from 'expo-sensors';

const COLORS = {
  bg: '#070A12', panel: '#0D1420', panel2: '#101A29', border: '#223044',
  text: '#F0F5FC', muted: '#8190A6', dim: '#53657D', cyan: '#5CF6E5',
  cyanDark: '#112D2C', pink: '#F871B3', violet: '#A28BFF', red: '#FF8C9F',
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const wrapAngle = (angle) => {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
};

function normalizeHost(rawValue) {
  let value = String(rawValue || '').trim();

  value = value
    .replace(/^https?:\/\//i, '')
    .replace(/^wss?:\/\//i, '')
    .replace(/\/+$/, '');

  if (!value || /[\s/?#@]/.test(value)) {
    throw new Error(
      'Enter the laptop address exactly as shown, e.g. 192.168.1.24:3000.'
    );
  }

  let parsed;

  try {
    parsed = new URL(`http://${value}`);
  } catch {
    throw new Error('That server address is not valid.');
  }

  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'Enter only the laptop IP and port, for example 192.168.1.24:3000.'
    );
  }

  if (
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1'
  ) {
    throw new Error('Use the laptop Wi-Fi IP address, not localhost.');
  }

  return parsed.host;
}

export default function App() {
  const [host, setHost] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [gameConnected, setGameConnected] = useState(false);
  const [error, setError] = useState('');
  const [tilt, setTilt] = useState(0);
  const [throttle, setThrottle] = useState(0);
  const [latency, setLatency] = useState(null);
  const [manualBoost, setManualBoost] = useState(false);
  const [sensorReady, setSensorReady] = useState(false);
  const [sensorMessage, setSensorMessage] = useState('Motion sensor is idle');

  const socketRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const shouldReconnectRef = useRef(false);
  const generationRef = useRef(0);
  const configRef = useRef(null);
  const baselineRef = useRef(null);
  const rawRotationRef = useRef(null);
  const controlsRef = useRef({ steer: 0, throttle: 0 });
  const manualBoostRef = useRef(false);
  const boostUntilRef = useRef(0);
  const lastShakeAtRef = useRef(0);
  const sequenceRef = useRef(1);
  const lastUiUpdateRef = useRef(0);

  // Limit sensor-driven WebSocket traffic to approximately 30 messages/second.
  const lastInputSendAtRef = useRef(0);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
    }

    reconnectTimerRef.current = null;
  }, []);

  const detachSocket = useCallback(() => {
    generationRef.current += 1;
    clearReconnectTimer();

    const previous = socketRef.current;
    socketRef.current = null;

    if (previous) {
      previous.onopen = null;
      previous.onmessage = null;
      previous.onerror = null;
      previous.onclose = null;

      try {
        previous.close();
      } catch {
        // Socket may already be closed.
      }
    }
  }, [clearReconnectTimer]);

  const openSocketRef = useRef(null);

  const scheduleReconnect = useCallback((config, generation) => {
    if (
      !shouldReconnectRef.current ||
      generation !== generationRef.current ||
      reconnectTimerRef.current
    ) {
      return;
    }

    setConnectionStatus('reconnecting');

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;

      if (shouldReconnectRef.current && configRef.current) {
        openSocketRef.current?.(config);
      }
    }, 1400);
  }, []);

  openSocketRef.current = (config) => {
    if (!shouldReconnectRef.current) return;

    clearReconnectTimer();

    const generation = ++generationRef.current;
    const socket = new WebSocket(`ws://${config.host}/ws`);

    socketRef.current = socket;
    setConnectionStatus('connecting');

    socket.onopen = () => {
      if (generation !== generationRef.current) return;

      try {
        socket.send(
          JSON.stringify({
            type: 'join',
            role: 'controller',
            code: config.code,
          })
        );
      } catch {
        socket.close();
      }
    };

    socket.onmessage = (event) => {
      if (generation !== generationRef.current) return;

      let message;

      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === 'joined') {
        setConnectionStatus('connected');
        setGameConnected(Boolean(message.peerConnected));
        setError('');
      } else if (message.type === 'peer' && message.role === 'game') {
        setGameConnected(Boolean(message.connected));
      } else if (message.type === 'ack') {
        if (Number.isFinite(message.clientTime)) {
          setLatency(Math.max(0, Date.now() - message.clientTime));
        }
      } else if (message.type === 'error') {
        shouldReconnectRef.current = false;
        setConnectionStatus('disconnected');

        setError(
          message.message ||
            'The server rejected this connection. Check the room code.'
        );

        try {
          socket.close();
        } catch {
          // No action needed.
        }
      } else if (message.type === 'replaced') {
        shouldReconnectRef.current = false;
        setConnectionStatus('disconnected');
        setError('This controller was replaced by another connection.');
      }
    };

    socket.onerror = () => {
      if (generation !== generationRef.current) return;

      setError(
        'Cannot reach the laptop. Check the IP, port, and same Wi-Fi network.'
      );
    };

    socket.onclose = (event) => {
      if (generation !== generationRef.current) return;

      if (socketRef.current === socket) {
        socketRef.current = null;
      }

      setGameConnected(false);

      if (!shouldReconnectRef.current) {
        setConnectionStatus('disconnected');
      } else if (event.code === 1008) {
        shouldReconnectRef.current = false;
        setConnectionStatus('disconnected');
      } else {
        scheduleReconnect(config, generation);
      }
    };
  };

  const sendInput = useCallback(
    (boost = false) => {
      const socket = socketRef.current;

      if (
        !socket ||
        socket.readyState !== WebSocket.OPEN ||
        connectionStatus !== 'connected'
      ) {
        return;
      }

      try {
        socket.send(
          JSON.stringify({
            type: 'input',
            steer: clamp(controlsRef.current.steer, -1, 1),
            throttle: clamp(controlsRef.current.throttle, -1, 1),
            boost: Boolean(boost),
            seq: sequenceRef.current++,
            clientTime: Date.now(),
          })
        );
      } catch {
        setError('Input stream paused. Reconnecting…');
      }
    },
    [connectionStatus]
  );

  useEffect(() => {
    if (connectionStatus !== 'connected') {
      setSensorReady(false);
      return undefined;
    }

    let cancelled = false;
    let subscription = null;

    const startSensor = async () => {
      try {
        const available = await DeviceMotion.isAvailableAsync();

        if (cancelled) return;

        if (!available) {
          setSensorReady(false);
          setSensorMessage(
            'No motion sensor detected. Use a physical phone, not a simulator.'
          );
          setError(
            'The controller connected, but this device does not expose motion sensors.'
          );
          return;
        }

        DeviceMotion.setUpdateInterval(33);
        baselineRef.current = null;

        let smoothedSteer = 0;
        let smoothedThrottle = 0;

        subscription = DeviceMotion.addListener((sample) => {
          if (cancelled) return;

          const rotation = sample?.rotation;

          if (
            !rotation ||
            !Number.isFinite(rotation.gamma) ||
            !Number.isFinite(rotation.beta)
          ) {
            return;
          }

          const raw = {
            gamma: rotation.gamma,
            beta: rotation.beta,
          };

          rawRotationRef.current = raw;

          if (!baselineRef.current) {
            baselineRef.current = raw;
          }

          const baseline = baselineRef.current;

          const steerDelta = wrapAngle(raw.gamma - baseline.gamma);
          const throttleDelta = wrapAngle(raw.beta - baseline.beta);

          const steer = clamp(steerDelta / 0.46, -1, 1);
          const pitch = clamp(-throttleDelta / 0.75, -1, 1);

          smoothedSteer = smoothedSteer * 0.62 + steer * 0.38;
          smoothedThrottle = smoothedThrottle * 0.7 + pitch * 0.3;

          controlsRef.current = {
            steer: smoothedSteer,
            throttle: smoothedThrottle,
          };

          // A sharp acceleration spike triggers a short boost.
          const acceleration = sample?.acceleration;

          if (
            acceleration &&
            [
              acceleration.x,
              acceleration.y,
              acceleration.z,
            ].every(Number.isFinite)
          ) {
            const magnitude = Math.sqrt(
              acceleration.x ** 2 +
                acceleration.y ** 2 +
                acceleration.z ** 2
            );

            const now = Date.now();

            if (
              magnitude > 16.5 &&
              now - lastShakeAtRef.current > 1250
            ) {
              lastShakeAtRef.current = now;
              boostUntilRef.current = now + 330;
            }
          }

          const now = Date.now();
          const boostActive =
            manualBoostRef.current || now < boostUntilRef.current;

          // Send no more than one sensor input packet every 33 ms.
          if (now - lastInputSendAtRef.current >= 33) {
            lastInputSendAtRef.current = now;
            sendInput(boostActive);
          }

          // Avoid unnecessary React renders for every sensor sample.
          if (now - lastUiUpdateRef.current >= 100) {
            lastUiUpdateRef.current = now;
            setTilt(smoothedSteer);
            setThrottle(smoothedThrottle);
          }
        });

        setSensorReady(true);
        setSensorMessage('Live motion stream · hold phone upright');
      } catch (sensorError) {
        if (cancelled) return;

        setSensorReady(false);
        setSensorMessage('Could not read motion sensor');

        setError(
          sensorError?.message || 'Motion sensor initialization failed.'
        );
      }
    };

    startSensor();

    return () => {
      cancelled = true;

      if (subscription) {
        subscription.remove();
      }
    };
  }, [connectionStatus, sendInput]);

  useEffect(
    () => () => {
      shouldReconnectRef.current = false;
      detachSocket();
    },
    [detachSocket]
  );

  const connect = useCallback(() => {
    setError('');

    let normalizedHost;

    try {
      normalizedHost = normalizeHost(host);
    } catch (validationError) {
      setError(validationError.message);
      return;
    }

    const code = String(roomCode || '').replace(/\D/g, '');

    if (!/^\d{6}$/.test(code)) {
      setError('Enter the six-digit room code shown on the laptop game page.');
      return;
    }

    shouldReconnectRef.current = false;
    detachSocket();

    shouldReconnectRef.current = true;

    configRef.current = {
      host: normalizedHost,
      code,
    };

    setGameConnected(false);
    setLatency(null);
    baselineRef.current = null;
    lastInputSendAtRef.current = 0;

    openSocketRef.current?.(configRef.current);
  }, [detachSocket, host, roomCode]);

  const disconnect = useCallback(() => {
    shouldReconnectRef.current = false;
    detachSocket();

    setConnectionStatus('disconnected');
    setGameConnected(false);
    setSensorReady(false);
    setSensorMessage('Motion sensor is idle');

    controlsRef.current = {
      steer: 0,
      throttle: 0,
    };

    manualBoostRef.current = false;
    boostUntilRef.current = 0;

    setManualBoost(false);
    setTilt(0);
    setThrottle(0);
    setLatency(null);
    setError('');
  }, [detachSocket]);

  const calibrate = useCallback(() => {
    if (!rawRotationRef.current) {
      setError('Wait for live sensor data, then calibrate.');
      return;
    }

    baselineRef.current = {
      ...rawRotationRef.current,
    };

    controlsRef.current = {
      steer: 0,
      throttle: 0,
    };

    setTilt(0);
    setThrottle(0);
    setError('');
    setSensorMessage('Calibrated · neutral position saved');

    sendInput(false);
  }, [sendInput]);

  const beginBoost = useCallback(() => {
    manualBoostRef.current = true;
    setManualBoost(true);

    // Manual button presses send immediately.
    sendInput(true);
  }, [sendInput]);

  const endBoost = useCallback(() => {
    manualBoostRef.current = false;
    setManualBoost(false);

    // Immediately tell the game that manual boost has ended.
    sendInput(false);
  }, [sendInput]);

  const connected = connectionStatus === 'connected';

  const connecting =
    connectionStatus === 'connecting' ||
    connectionStatus === 'reconnecting';

  const statusText = connected
    ? gameConnected
      ? 'LINK ESTABLISHED'
      : 'APP CONNECTED · WAITING FOR GAME'
    : connecting
      ? 'CONNECTING TO LAPTOP'
      : 'NOT CONNECTED';
        return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <View style={styles.brandMark}>
              <Text style={styles.brandM}>M</Text>
            </View>

            <View style={styles.brandCopy}>
              <Text style={styles.brand}>
                MOTION<Text style={styles.brandAccent}>DRIVE</Text>
              </Text>
              <Text style={styles.brandSub}>
                MOTION CONTROLLER / 001
              </Text>
            </View>

            <View
              style={[
                styles.topDot,
                connected
                  ? styles.dotGood
                  : connecting
                    ? styles.dotWarm
                    : styles.dotIdle,
              ]}
            />
          </View>

          <View style={styles.hero}>
            <Text style={styles.eyebrow}>
              // YOUR PHONE IS THE WHEEL
            </Text>

            <Text style={styles.title}>
              Move fast.
              {'\n'}
              <Text style={styles.titleAccent}>Stay in control.</Text>
            </Text>

            <Text style={styles.heroText}>
              Pair once. Tilt to steer. Shake to boost. MotionDrive streams
              your movement straight to the browser game.
            </Text>
          </View>

          <View style={styles.statusCard}>
            <View style={styles.statusTopRow}>
              <View
                style={[
                  styles.statusPip,
                  connected && styles.statusPipGood,
                  connecting && styles.statusPipWarm,
                ]}
              />

              <Text style={styles.statusLabel}>{statusText}</Text>

              <View style={styles.latencyBox}>
                <Text style={styles.latencyLabel}>PING</Text>
                <Text style={styles.latencyValue}>
                  {latency === null ? '—' : `${latency} ms`}
                </Text>
              </View>
            </View>

            <View style={styles.statusRule} />

            <View style={styles.statusBottomRow}>
              <View>
                <Text style={styles.smallLabel}>GAME CLIENT</Text>
                <Text
                  style={[
                    styles.smallValue,
                    gameConnected && styles.goodText,
                  ]}
                >
                  {gameConnected ? 'ONLINE' : 'SEARCHING'}
                </Text>
              </View>

              <View>
                <Text style={styles.smallLabel}>MOTION SENSOR</Text>
                <Text
                  style={[
                    styles.smallValue,
                    sensorReady && styles.goodText,
                  ]}
                >
                  {sensorReady ? 'STREAMING' : 'STANDBY'}
                </Text>
              </View>

              <View>
                <Text style={styles.smallLabel}>PROTOCOL</Text>
                <Text style={styles.smallValue}>WEBSOCKET</Text>
              </View>
            </View>
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionNumber}>01</Text>
            <Text style={styles.sectionTitle}>PAIR YOUR LAPTOP</Text>
            <View style={styles.sectionLine} />
          </View>

          <View style={styles.formCard}>
            <Text style={styles.fieldLabel}>SERVER ADDRESS</Text>

            <TextInput
              value={host}
              onChangeText={setHost}
              placeholder="192.168.1.24:3000"
              placeholderTextColor={COLORS.dim}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="next"
              style={styles.input}
              accessibilityLabel="Laptop server address"
            />

            <Text style={styles.fieldHelp}>
              Use the IP printed on the laptop game screen — not localhost.
              Both devices must use the same Wi-Fi.
            </Text>

            <Text style={[styles.fieldLabel, styles.codeLabel]}>
              SIX-DIGIT ROOM CODE
            </Text>

            <TextInput
              value={roomCode}
              onChangeText={(value) =>
                setRoomCode(value.replace(/\D/g, '').slice(0, 6))
              }
              placeholder="000000"
              placeholderTextColor={COLORS.dim}
              keyboardType="number-pad"
              maxLength={6}
              style={[styles.input, styles.codeInput]}
              accessibilityLabel="Six-digit room code"
            />

            <View style={styles.buttonRow}>
              <Pressable
                onPress={connect}
                disabled={connecting}
                style={({ pressed }) => [
                  styles.connectButton,
                  pressed && styles.pressed,
                  connecting && styles.disabledButton,
                ]}
                accessibilityRole="button"
              >
                {connecting ? (
                  <ActivityIndicator color={COLORS.bg} size="small" />
                ) : (
                  <Text style={styles.connectText}>
                    {connected ? 'RECONNECT ↗' : 'CONNECT ↗'}
                  </Text>
                )}
              </Pressable>

              <Pressable
                onPress={disconnect}
                disabled={!connected && !connecting}
                style={({ pressed }) => [
                  styles.disconnectButton,
                  pressed && styles.pressed,
                  !connected && !connecting && styles.disabledOutline,
                ]}
                accessibilityRole="button"
              >
                <Text style={styles.disconnectText}>DISCONNECT</Text>
              </Pressable>
            </View>

            {error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionNumber}>02</Text>
            <Text style={styles.sectionTitle}>CALIBRATE YOUR WHEEL</Text>
            <View style={styles.sectionLine} />
          </View>

          <View style={styles.calibrateCard}>
            <View style={styles.calibrateCopy}>
              <Text style={styles.cardTitle}>Find your neutral.</Text>
              <Text style={styles.cardDescription}>
                Hold your phone upright in a comfortable position. Tap
                calibrate, then tilt gently left or right to steer.
              </Text>
            </View>

            <Pressable
              onPress={calibrate}
              disabled={!connected || !sensorReady}
              style={({ pressed }) => [
                styles.calibrateButton,
                (!connected || !sensorReady) && styles.disabledOutline,
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
            >
              <Text style={styles.calibrateButtonText}>
                ◎ CALIBRATE
              </Text>
            </Pressable>

            <Text style={styles.sensorMessage}>{sensorMessage}</Text>

            <View style={styles.meterHeader}>
              <Text style={styles.fieldLabel}>STEERING INPUT</Text>
              <Text style={styles.meterValue}>
                {Math.round(tilt * 100)}%
              </Text>
            </View>

            <View style={styles.meterTrack}>
              <View style={styles.meterCenter} />
              <View
                style={[
                  styles.meterNeedle,
                  { left: `${50 + tilt * 45}%` },
                ]}
              />
            </View>

            <View style={styles.meterCaptions}>
              <Text style={styles.meterCaptionText}>← LEFT</Text>
              <Text style={styles.meterCaptionText}>NEUTRAL</Text>
              <Text style={styles.meterCaptionText}>RIGHT →</Text>
            </View>

            <View style={styles.throttleRow}>
              <Text style={styles.fieldLabel}>PITCH / THROTTLE</Text>

              <View style={styles.throttleTrack}>
                <View
                  style={[
                    styles.throttleFill,
                    {
                      width: `${Math.abs(throttle) * 100}%`,
                      alignSelf:
                        throttle < 0 ? 'flex-end' : 'flex-start',
                    },
                  ]}
                />
              </View>

              <Text style={styles.meterValue}>
                {Math.round(throttle * 100)}%
              </Text>
            </View>
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionNumber}>03</Text>
            <Text style={styles.sectionTitle}>LIVE CONTROLS</Text>
            <View style={styles.sectionLine} />
          </View>

          <View style={styles.controlCard}>
            <View style={styles.controlHeader}>
              <View>
                <Text style={styles.cardTitle}>Boost the run.</Text>
                <Text style={styles.cardDescription}>
                  Shake the phone for a burst, or press and hold below.
                </Text>
              </View>

              <Text style={styles.bolt}>ϟ</Text>
            </View>

            <Pressable
              onPressIn={beginBoost}
              onPressOut={endBoost}
              disabled={!connected}
              style={({ pressed }) => [
                styles.boostButton,
                (pressed || manualBoost) && styles.boostPressed,
                !connected && styles.disabledButton,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Press and hold to boost"
            >
              <Text style={styles.boostSymbol}>ϟ</Text>
              <Text style={styles.boostText}>
                {manualBoost
                  ? 'BOOST ACTIVE'
                  : 'PRESS & HOLD TO BOOST'}
              </Text>
            </Pressable>

            <View style={styles.controlFooter}>
              <View style={styles.pulseDot} />
              <Text style={styles.controlFooterText}>
                {connected
                  ? gameConnected
                    ? 'INPUTS ARE LIVE'
                    : 'CONNECTED — WAITING FOR GAME TAB'
                  : 'PAIR THE APP TO ENABLE LIVE INPUTS'}
              </Text>
            </View>
          </View>

          <View style={styles.tipCard}>
            <Text style={styles.tipGlyph}>✳</Text>

            <View style={styles.tipCopy}>
              <Text style={styles.tipTitle}>QUICK SETUP CHECKLIST</Text>
              <Text style={styles.tipText}>
                1. Start the laptop server. 2. Open the game page. 3. Enter
                the laptop IP and room code here. 4. Connect and calibrate.
              </Text>
            </View>
          </View>

          <Text style={styles.footer}>
            MOTIONDRIVE / BUILT FOR MOVEMENT / LOCAL NETWORK ONLY
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: COLORS.bg },
  scroll: {
    paddingHorizontal: 21,
    paddingTop: Platform.OS === 'ios' ? 12 : 8,
    paddingBottom: 34,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 19,
    borderBottomWidth: 1,
    borderBottomColor: '#172130',
  },
  brandMark: {
    width: 35,
    height: 35,
    borderWidth: 1,
    borderColor: COLORS.cyan,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-4deg' }],
    marginRight: 10,
  },
  brandM: { color: COLORS.cyan, fontSize: 19, fontWeight: '500' },
  brandCopy: { flex: 1 },
  brand: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  brandAccent: { color: COLORS.cyan },
  brandSub: {
    color: '#718198',
    fontSize: 8,
    marginTop: 3,
    letterSpacing: 1.05,
  },
  topDot: { width: 8, height: 8, borderRadius: 8 },
  dotGood: { backgroundColor: COLORS.cyan },
  dotWarm: { backgroundColor: '#F6B45D' },
  dotIdle: { backgroundColor: '#566476' },

  hero: { paddingTop: 27, paddingBottom: 22 },
  eyebrow: {
    color: COLORS.cyan,
    fontSize: 9,
    letterSpacing: 1.3,
    fontWeight: '600',
    marginBottom: 12,
  },
  title: {
    color: COLORS.text,
    fontSize: 39,
    lineHeight: 42,
    fontWeight: '800',
    letterSpacing: -1.8,
  },
  titleAccent: { color: COLORS.cyan },
  heroText: {
    marginTop: 14,
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 19,
    maxWidth: 420,
  },

  statusCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 6,
    backgroundColor: COLORS.panel,
    padding: 15,
  },
  statusTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 27,
  },
  statusPip: {
    width: 7,
    height: 7,
    borderRadius: 7,
    backgroundColor: '#586779',
    marginRight: 8,
  },
  statusPipGood: { backgroundColor: COLORS.cyan },
  statusPipWarm: { backgroundColor: '#F6B45D' },
  statusLabel: {
    flex: 1,
    color: '#B9C5D6',
    fontSize: 8,
    letterSpacing: 0.7,
    fontWeight: '700',
  },
  latencyBox: { alignItems: 'flex-end' },
  latencyLabel: {
    color: COLORS.dim,
    fontSize: 7,
    letterSpacing: 1,
  },
  latencyValue: {
    color: COLORS.cyan,
    fontSize: 10,
    marginTop: 3,
    fontWeight: '600',
  },
  statusRule: {
    height: 1,
    backgroundColor: '#1C2938',
    marginVertical: 11,
  },
  statusBottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  smallLabel: {
    color: COLORS.dim,
    fontSize: 7,
    letterSpacing: 0.6,
  },
  smallValue: {
    color: '#AEBBCD',
    fontSize: 8,
    fontWeight: '700',
    marginTop: 5,
  },
  goodText: { color: COLORS.cyan },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 28,
    marginBottom: 12,
  },
  sectionNumber: {
    color: COLORS.cyan,
    fontSize: 9,
    fontWeight: '700',
    marginRight: 9,
  },
  sectionTitle: {
    color: '#BAC7D8',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  sectionLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#1C2938',
    marginLeft: 11,
  },

  formCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 6,
    backgroundColor: COLORS.panel,
    padding: 15,
  },
  fieldLabel: {
    color: '#7F90A7',
    fontSize: 8,
    letterSpacing: 0.9,
    fontWeight: '700',
  },
  input: {
    backgroundColor: '#080E18',
    borderWidth: 1,
    borderColor: '#2A3A4E',
    borderRadius: 4,
    height: 47,
    color: COLORS.text,
    marginTop: 9,
    paddingHorizontal: 12,
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  fieldHelp: {
    color: '#677990',
    fontSize: 9,
    lineHeight: 14,
    marginTop: 8,
  },
  codeLabel: { marginTop: 21 },
  codeInput: {
    fontSize: 23,
    letterSpacing: 5,
    color: COLORS.cyan,
    fontWeight: '700',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
  },
  connectButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 45,
    borderRadius: 4,
    backgroundColor: COLORS.cyan,
  },
  connectText: {
    color: COLORS.bg,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1,
  },
  disconnectButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 45,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#39465A',
    borderRadius: 4,
  },
  disconnectText: {
    color: '#9BAAC0',
    fontSize: 9,
    fontWeight: '700',
  },
  pressed: { opacity: 0.72 },
  disabledButton: { opacity: 0.42 },
  disabledOutline: { opacity: 0.4 },
  errorBox: {
    padding: 10,
    borderColor: '#754051',
    borderWidth: 1,
    borderRadius: 4,
    backgroundColor: '#27151F',
    marginTop: 13,
  },
  errorText: {
    color: '#FF9BBC',
    fontSize: 10,
    lineHeight: 15,
  },

  calibrateCard: {
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 6,
    backgroundColor: COLORS.panel,
  },
  calibrateCopy: { marginBottom: 14 },
  cardTitle: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  cardDescription: {
    color: COLORS.muted,
    fontSize: 10,
    lineHeight: 16,
    marginTop: 5,
  },
  calibrateButton: {
    borderWidth: 1,
    borderColor: '#347A74',
    borderRadius: 4,
    backgroundColor: COLORS.cyanDark,
    paddingVertical: 12,
    alignItems: 'center',
  },
  calibrateButtonText: {
    color: COLORS.cyan,
    fontSize: 10,
    letterSpacing: 0.7,
    fontWeight: '800',
  },
  sensorMessage: {
    color: '#7D8EA5',
    fontSize: 9,
    marginTop: 12,
    marginBottom: 16,
  },
  meterHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  meterValue: {
    color: COLORS.cyan,
    fontSize: 9,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  meterTrack: {
    marginTop: 9,
    height: 12,
    borderRadius: 3,
    backgroundColor: '#080E17',
    borderWidth: 1,
    borderColor: '#28384B',
    justifyContent: 'center',
    position: 'relative',
  },
  meterCenter: {
    position: 'absolute',
    left: '50%',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: '#5D6C80',
  },
  meterNeedle: {
    position: 'absolute',
    top: -4,
    marginLeft: -2,
    width: 4,
    height: 18,
    borderRadius: 2,
    backgroundColor: COLORS.cyan,
    shadowColor: COLORS.cyan,
    shadowOpacity: 0.8,
    shadowRadius: 4,
    elevation: 3,
  },
  meterCaptions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 7,
  },
  meterCaptionText: { color: COLORS.dim, fontSize: 7 },

  throttleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginTop: 18,
  },
  throttleTrack: {
    height: 5,
    backgroundColor: '#243042',
    borderRadius: 4,
    flex: 1,
    overflow: 'hidden',
  },
  throttleFill: {
    height: 5,
    backgroundColor: COLORS.violet,
    borderRadius: 4,
  },

  controlCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 6,
    backgroundColor: COLORS.panel,
    padding: 16,
  },
  controlHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  bolt: { color: COLORS.pink, fontSize: 31 },
  boostButton: {
    backgroundColor: '#25152A',
    borderColor: '#754162',
    borderWidth: 1,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 15,
    marginTop: 17,
  },
  boostPressed: {
    backgroundColor: '#5A2245',
    borderColor: COLORS.pink,
  },
  boostSymbol: { fontSize: 24, color: COLORS.pink },
  boostText: {
    color: '#FFD7E8',
    fontSize: 9,
    letterSpacing: 1,
    fontWeight: '900',
    marginTop: 4,
  },
  controlFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 13,
    gap: 7,
  },
  pulseDot: {
    width: 6,
    height: 6,
    borderRadius: 6,
    backgroundColor: COLORS.cyan,
  },
  controlFooterText: {
    color: '#7B8CA3',
    fontSize: 7,
    letterSpacing: 0.5,
  },

  tipCard: {
    flexDirection: 'row',
    gap: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#243A43',
    borderRadius: 5,
    backgroundColor: '#0A181D',
    marginTop: 21,
  },
  tipGlyph: { color: COLORS.cyan, fontSize: 20 },
  tipCopy: { flex: 1 },
  tipTitle: {
    color: '#B7C8D2',
    fontSize: 8,
    letterSpacing: 1,
    fontWeight: '800',
  },
  tipText: {
    color: '#758B9D',
    fontSize: 9,
    lineHeight: 16,
    marginTop: 7,
  },
  footer: {
    textAlign: 'center',
    color: '#4E5C70',
    fontSize: 7,
    letterSpacing: 0.8,
    marginTop: 25,
  },
});