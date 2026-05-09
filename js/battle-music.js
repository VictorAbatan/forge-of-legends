// ═══════════════════════════════════════════════════════════════
//  FORGE OF LEGENDS — BATTLE MUSIC ENGINE  (Web Audio API)
//  No external URLs · No copyright · Works offline · Zero latency
//
//  Three moods:
//    'battle'    — tense, rhythmic, mid-tempo manual fight
//    'auto'      — lighter grind loop for auto-battle
//    'boss'      — epic, heavy, intense boss raid
//
//  Public API (attached to window):
//    window.BattleMusic.start(mood)   — begin a mood
//    window.BattleMusic.stop()        — fade out & stop
//    window.BattleMusic.setVolume(v)  — 0.0 – 1.0
//
//  PERF FIX: Noise/hihat buffers are pre-baked once at init.
//  Percussion scheduling is split across async microtasks so the
//  main thread is never blocked — no more 10-second UI freezes.
// ═══════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────
  let _ctx      = null;   // AudioContext
  let _master   = null;   // GainNode
  let _nodes    = [];     // all active nodes for this session
  let _running  = false;
  let _mood     = null;
  let _vol      = 0.38;
  let _stopTokens = [];

  // ── Pre-baked percussion buffers (created once, reused forever)
  let _noiseBuf  = null;  // ~0.12s noise for snare
  let _hihatBuf  = null;  // ~0.04s noise for hi-hat

  // ── Init AudioContext lazily + pre-bake buffers ──────────────
  function _initCtx() {
    if (_ctx) return true;
    try {
      _ctx    = new (window.AudioContext || window.webkitAudioContext)();
      _master = _ctx.createGain();
      _master.gain.value = _vol;
      _master.connect(_ctx.destination);

      // Pre-bake noise buffers ONCE — never again inside the loop
      const sr = _ctx.sampleRate;

      _noiseBuf = _ctx.createBuffer(1, Math.ceil(sr * 0.12), sr);
      const nd  = _noiseBuf.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

      _hihatBuf = _ctx.createBuffer(1, Math.ceil(sr * 0.04), sr);
      const hd  = _hihatBuf.getChannelData(0);
      for (let i = 0; i < hd.length; i++) hd[i] = Math.random() * 2 - 1;

      return true;
    } catch (e) {
      console.warn('[BattleMusic] Web Audio API not available:', e);
      return false;
    }
  }

  // ── Helper: create & register a gain node ───────────────────
  function _gain(value) {
    const g = _ctx.createGain();
    g.gain.value = value;
    g.connect(_master);
    _nodes.push(g);
    return g;
  }

  // ── Helper: schedule a sine/square/sawtooth/triangle tone ───
  function _tone(freq, type, startTime, duration, gainNode, vol = 1) {
    const osc = _ctx.createOscillator();
    const env = _ctx.createGain();
    osc.type      = type;
    osc.frequency.setValueAtTime(freq, startTime);
    env.gain.setValueAtTime(0, startTime);
    env.gain.linearRampToValueAtTime(vol, startTime + 0.02);
    env.gain.setValueAtTime(vol, startTime + duration - 0.04);
    env.gain.linearRampToValueAtTime(0, startTime + duration);
    osc.connect(env);
    env.connect(gainNode);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
    _nodes.push(osc, env);
  }

  // ── Helper: noise burst — REUSES pre-baked buffer ───────────
  function _noise(startTime, duration, gainNode, vol = 0.12) {
    const src    = _ctx.createBufferSource();
    src.buffer   = _noiseBuf;   // ← pre-baked, zero allocation
    const filter = _ctx.createBiquadFilter();
    filter.type  = 'bandpass';
    filter.frequency.value = 200;
    filter.Q.value         = 0.8;
    const env = _ctx.createGain();
    env.gain.setValueAtTime(0, startTime);
    env.gain.linearRampToValueAtTime(vol, startTime + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + Math.min(duration, 0.12));
    src.connect(filter);
    filter.connect(env);
    env.connect(gainNode);
    src.start(startTime);
    src.stop(startTime + Math.min(duration, 0.12) + 0.01);
    _nodes.push(src, filter, env);
  }

  // ── Helper: hi-hat click — REUSES pre-baked buffer ──────────
  function _hihat(startTime, gainNode, vol = 0.06) {
    const src    = _ctx.createBufferSource();
    src.buffer   = _hihatBuf;   // ← pre-baked, zero allocation
    const filter = _ctx.createBiquadFilter();
    filter.type  = 'highpass';
    filter.frequency.value = 7000;
    const env = _ctx.createGain();
    env.gain.setValueAtTime(vol, startTime);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.04);
    src.connect(filter);
    filter.connect(env);
    env.connect(gainNode);
    src.start(startTime);
    src.stop(startTime + 0.06);
    _nodes.push(src, filter, env);
  }

  // ── Helper: low kick drum ────────────────────────────────────
  function _kick(startTime, gainNode, vol = 0.5) {
    const osc = _ctx.createOscillator();
    const env = _ctx.createGain();
    osc.type  = 'sine';
    osc.frequency.setValueAtTime(140, startTime);
    osc.frequency.exponentialRampToValueAtTime(40, startTime + 0.15);
    env.gain.setValueAtTime(vol, startTime);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.2);
    osc.connect(env);
    env.connect(gainNode);
    osc.start(startTime);
    osc.stop(startTime + 0.25);
    _nodes.push(osc, env);
  }

  // ── Helper: low bass pulse ───────────────────────────────────
  function _bass(freq, startTime, duration, gainNode, vol = 0.35) {
    const osc = _ctx.createOscillator();
    const env = _ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, startTime);
    env.gain.setValueAtTime(0, startTime);
    env.gain.linearRampToValueAtTime(vol, startTime + 0.01);
    env.gain.setValueAtTime(vol, startTime + duration - 0.04);
    env.gain.linearRampToValueAtTime(0, startTime + duration);
    const filter = _ctx.createBiquadFilter();
    filter.type  = 'lowpass';
    filter.frequency.value = 300;
    osc.connect(filter);
    filter.connect(env);
    env.connect(gainNode);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
    _nodes.push(osc, filter, env);
  }

  // ── Helper: schedule percussion bars asynchronously ─────────
  // Splits bar scheduling across setTimeout(0) ticks so the main
  // thread yields between batches — UI actions stay responsive.
  function _schedPercAsync(loopBars, now, beat, percG, barFn, doneFn) {
    let bar = 0;
    function schedNext() {
      if (bar >= loopBars) { if (doneFn) doneFn(); return; }
      barFn(bar, now + bar * beat * 4, percG);
      bar++;
      setTimeout(schedNext, 0);
    }
    setTimeout(schedNext, 0);
  }

  // ══════════════════════════════════════════════════════════════
  //  MOOD: BATTLE  — tense, rhythmic, mid-tempo
  // ══════════════════════════════════════════════════════════════
  const BATTLE_MELODY = [
    [146.8, 0.22], [146.8, 0.22], [174.6, 0.22], [220, 0.22],
    [261.6, 0.22], [220, 0.22],   [174.6, 0.22], [164.8, 0.22],
    [146.8, 0.44], [174.6, 0.22], [196, 0.22],
    [220, 0.22],   [174.6, 0.22], [146.8, 0.44], [0, 0.22],
  ];
  const BATTLE_BASS = [
    [73.4, 0.44], [73.4, 0.44], [87.3, 0.44], [82.4, 0.44],
    [73.4, 0.44], [87.3, 0.44], [73.4, 0.44], [65.4, 0.44],
  ];
  const BATTLE_LOOP_LEN = BATTLE_MELODY.reduce((s, [, d]) => s + d, 0);
  const BATTLE_BASS_LEN = BATTLE_BASS.reduce((s, [, d]) => s + d, 0);

  function _playBattleLoop(token) {
    if (!_running || token.cancelled) return;

    const melodyG = _gain(0.18);
    const bassG   = _gain(0.28);
    const percG   = _gain(0.22);
    const padG    = _gain(0.10);

    const now  = _ctx.currentTime + 0.05;
    const bpm  = 116;
    const beat = 60 / bpm;

    // ── Melody (lead square) — scheduled synchronously (few nodes)
    let t = now;
    for (const [freq, dur] of BATTLE_MELODY) {
      if (freq > 0) _tone(freq, 'square', t, dur * 0.85, melodyG, 0.9);
      t += dur;
    }

    // ── Counter-melody ──
    const counterMel = [
      [293.7, 0.22], [0, 0.22], [349.2, 0.22], [0, 0.22],
      [523.3, 0.44], [440, 0.22], [0, 0.22],
      [349.2, 0.44], [329.6, 0.22], [0, 0.22],
      [293.7, 0.44], [0, 0.22 * 4],
    ];
    let tc = now + beat * 2;
    for (const [freq, dur] of counterMel) {
      if (freq > 0) _tone(freq, 'triangle', tc, dur * 0.7, melodyG, 0.5);
      tc += dur;
    }

    // ── Bass ──
    let tb = now;
    for (const [freq, dur] of BATTLE_BASS) {
      _bass(freq, tb, dur * 0.7, bassG, 0.4);
      tb += dur;
    }
    let tb2 = now + BATTLE_BASS_LEN;
    for (const [freq, dur] of BATTLE_BASS) {
      _bass(freq, tb2, dur * 0.7, bassG, 0.4);
      tb2 += dur;
    }

    // ── Pad ──
    const padNotes = [146.8, 174.6, 220, 261.6];
    for (const f of padNotes) {
      _tone(f, 'sine', now, BATTLE_LOOP_LEN * 0.9, padG, 0.3);
    }

    // ── Percussion — async so UI thread is never blocked ──
    const loopBars = 8;
    const loopDur  = Math.max(BATTLE_LOOP_LEN, beat * 4 * loopBars);

    _schedPercAsync(loopBars, now, beat, percG,
      function battleBar(bar, bStart, pg) {
        _kick(bStart, pg, 0.55);
        _kick(bStart + beat * 2, pg, 0.45);
        _noise(bStart + beat, 0.08, pg, 0.18);
        _noise(bStart + beat * 3, 0.08, pg, 0.14);
        for (let h = 0; h < 8; h++) {
          _hihat(bStart + h * beat * 0.5, pg, 0.05 + (h % 2 === 0 ? 0.02 : 0));
        }
      }
    );

    setTimeout(() => _playBattleLoop(token), (loopDur - 0.1) * 1000);
  }

  // ══════════════════════════════════════════════════════════════
  //  MOOD: AUTO  — lighter grind loop
  // ══════════════════════════════════════════════════════════════
  const AUTO_ARPEGGIO = [
    [220, 0.18], [261.6, 0.18], [293.7, 0.18], [329.6, 0.18],
    [392, 0.18],  [329.6, 0.18], [293.7, 0.18], [261.6, 0.18],
    [220, 0.18],  [196, 0.18],   [220, 0.36],   [0, 0.18],
  ];
  const AUTO_LOOP_LEN = AUTO_ARPEGGIO.reduce((s, [, d]) => s + d, 0);

  function _playAutoLoop(token) {
    if (!_running || token.cancelled) return;

    const arpG  = _gain(0.14);
    const bassG = _gain(0.22);
    const percG = _gain(0.15);
    const padG  = _gain(0.08);

    const now  = _ctx.currentTime + 0.05;
    const bpm  = 108;
    const beat = 60 / bpm;

    // ── Arpeggio ──
    let t = now;
    for (const [freq, dur] of AUTO_ARPEGGIO) {
      if (freq > 0) _tone(freq, 'triangle', t, dur * 0.75, arpG, 0.8);
      t += dur;
    }
    let t2 = now + AUTO_LOOP_LEN;
    for (const [freq, dur] of AUTO_ARPEGGIO) {
      if (freq > 0) _tone(freq * 2, 'triangle', t2, dur * 0.6, arpG, 0.4);
      t2 += dur;
    }

    // ── Bass pulse ──
    const bassNotes = [110, 110, 130.8, 110, 110, 98, 110, 130.8];
    for (let i = 0; i < bassNotes.length; i++) {
      _bass(bassNotes[i], now + i * beat, beat * 0.6, bassG, 0.3);
    }
    for (let i = 0; i < bassNotes.length; i++) {
      _bass(bassNotes[i], now + AUTO_LOOP_LEN + i * beat, beat * 0.6, bassG, 0.3);
    }

    // ── Pad (Am chord) ──
    const padNotes = [110, 130.8, 164.8, 220];
    for (const f of padNotes) {
      _tone(f, 'sine', now, AUTO_LOOP_LEN * 1.8, padG, 0.25);
    }

    // ── Percussion — async ──
    const loopBars = 8;
    const loopDur  = Math.max(AUTO_LOOP_LEN * 2, beat * 4 * loopBars);

    _schedPercAsync(loopBars, now, beat, percG,
      function autoBar(bar, bStart, pg) {
        _kick(bStart, pg, 0.35);
        _noise(bStart + beat * 2, 0.06, pg, 0.1);
        for (let h = 0; h < 8; h++) {
          if (h % 2 === 0) _hihat(bStart + h * beat * 0.5, pg, 0.03);
        }
      }
    );

    setTimeout(() => _playAutoLoop(token), (loopDur - 0.15) * 1000);
  }

  // ══════════════════════════════════════════════════════════════
  //  MOOD: BOSS  — epic, heavy, intense
  // ══════════════════════════════════════════════════════════════
  const BOSS_FANFARE = [
    [246.9, 0.25], [220, 0.25], [196, 0.25], [185, 0.5],
    [0, 0.1],
    [185, 0.25], [196, 0.25], [220, 0.25], [246.9, 0.25], [293.7, 0.5],
    [0, 0.1],
    [293.7, 0.25], [329.6, 0.25], [369.9, 0.25], [392, 0.75],
    [0, 0.25],
  ];
  const BOSS_COUNTER = [
    [493.9, 0.5], [0, 0.25], [440, 0.25], [415.3, 0.5], [0, 0.25],
    [440, 0.5], [493.9, 0.5], [0, 0.25],
    [587.3, 0.75], [0, 0.25], [554.4, 0.25], [493.9, 0.75],
  ];
  const BOSS_BASS_RIFF = [
    [61.7, 0.25], [61.7, 0.25], [92.5, 0.25], [61.7, 0.25],
    [61.7, 0.25], [82.4, 0.5],  [61.7, 0.25],
    [61.7, 0.25], [55, 0.5],    [61.7, 0.25],
    [61.7, 0.25], [73.4, 0.25], [82.4, 0.25], [61.7, 0.5],
  ];
  const BOSS_LOOP_LEN = BOSS_FANFARE.reduce((s, [, d]) => s + d, 0);

  function _playBossLoop(token) {
    if (!_running || token.cancelled) return;

    const leadG   = _gain(0.20);
    const counterG = _gain(0.12);
    const bassG   = _gain(0.30);
    const percG   = _gain(0.28);
    const padG    = _gain(0.12);
    const stringG = _gain(0.10);

    const now  = _ctx.currentTime + 0.05;
    const bpm  = 128;
    const beat = 60 / bpm;

    // ── Lead melody (sawtooth — aggressive) ──
    let t = now;
    for (const [freq, dur] of BOSS_FANFARE) {
      if (freq > 0) {
        _tone(freq, 'sawtooth', t, dur * 0.8, leadG, 1.0);
        _tone(freq * 1.005, 'sawtooth', t, dur * 0.8, leadG, 0.4);
      }
      t += dur;
    }

    // ── Counter melody ──
    let tc = now + beat * 4;
    for (const [freq, dur] of BOSS_COUNTER) {
      if (freq > 0) _tone(freq, 'square', tc, dur * 0.7, counterG, 0.7);
      tc += dur;
    }

    // ── Bass riff ──
    let tb = now;
    while (tb < now + BOSS_LOOP_LEN) {
      for (const [freq, dur] of BOSS_BASS_RIFF) {
        if (tb >= now + BOSS_LOOP_LEN) break;
        _bass(freq, tb, dur * 0.75, bassG, 0.5);
        tb += dur;
      }
    }

    // ── Ominous pad (Bm chord) ──
    const padChord = [123.5, 185, 246.9, 293.7, 369.9];
    for (const f of padChord) {
      _tone(f, 'sine', now, BOSS_LOOP_LEN * 0.95, padG, 0.22);
    }

    // ── Tremolo string effect ──
    const stringNotes = [369.9, 329.6, 293.7, 369.9];
    for (let sn = 0; sn < stringNotes.length; sn++) {
      const sStart = now + sn * beat * 4;
      for (let p = 0; p < 24; p++) {
        _tone(stringNotes[sn], 'triangle', sStart + p * beat * 0.167, beat * 0.12, stringG, 0.35);
      }
    }

    // ── Heavy percussion — async ──
    const loopBars = 8;
    const loopDur  = Math.max(BOSS_LOOP_LEN, beat * 4 * loopBars);

    _schedPercAsync(loopBars, now, beat, percG,
      function bossBar(bar, bStart, pg) {
        _kick(bStart, pg, 0.65);
        _kick(bStart + beat * 0.5, pg, 0.45);
        _kick(bStart + beat * 2, pg, 0.60);
        _kick(bStart + beat * 2.75, pg, 0.40);
        _noise(bStart + beat, 0.12, pg, 0.28);
        _noise(bStart + beat * 3, 0.12, pg, 0.28);
        _hihat(bStart + beat * 2.5, pg, 0.09);
        if (bar === 3 || bar === 7) {
          for (let h = 0; h < 16; h++) {
            _hihat(bStart + h * beat * 0.25, pg, 0.04);
          }
        }
      }
    );

    setTimeout(() => _playBossLoop(token), (loopDur - 0.15) * 1000);
  }

  // ══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════════════════════════════
  function start(mood) {
    if (!_initCtx()) return;
    if (_ctx.state === 'suspended') _ctx.resume();
    if (_running && _mood === mood) return;

    _stopImmediate();

    _running = true;
    _mood    = mood;
    const token = { cancelled: false };
    _stopTokens = [token];

    _master.gain.setValueAtTime(0, _ctx.currentTime);
    _master.gain.linearRampToValueAtTime(_vol, _ctx.currentTime + 1.2);

    if (mood === 'battle')    _playBattleLoop(token);
    else if (mood === 'auto') _playAutoLoop(token);
    else if (mood === 'boss') _playBossLoop(token);
    _setPillVisible(true);
  }

  function stop() {
    if (!_running) return;
    _setPillVisible(false);
    _stopTokens.forEach(t => t.cancelled = true);
    _stopTokens = [];
    if (_master && _ctx) {
      _master.gain.setValueAtTime(_master.gain.value, _ctx.currentTime);
      _master.gain.linearRampToValueAtTime(0, _ctx.currentTime + 1.2);
    }
    setTimeout(_stopImmediate, 1400);
  }

  function _stopImmediate() {
    _running = false;
    _mood    = null;
    _stopTokens.forEach(t => t.cancelled = true);
    _stopTokens = [];
    _nodes.forEach(n => { try { n.disconnect(); } catch(_) {} });
    _nodes = [];
    if (_ctx) {
      _master = _ctx.createGain();
      _master.gain.value = _vol;
      _master.connect(_ctx.destination);
    }
  }

  function setVolume(v) {
    _vol = Math.max(0, Math.min(1, v));
    if (_master && _running) {
      _master.gain.setValueAtTime(_vol, _ctx.currentTime);
    }
  }

  function isPlaying(mood) {
    return _running && (!mood || _mood === mood);
  }

  window.BattleMusic = { start, stop, setVolume, isPlaying };

  function _setPillVisible(visible) {
    const pill = document.getElementById('music-widget');
    if (!pill) return;
    pill.style.opacity      = visible ? '1' : '0';
    pill.style.pointerEvents = visible ? 'auto' : 'none';
  }

})();