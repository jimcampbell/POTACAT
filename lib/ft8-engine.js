/**
 * FT8 Engine — Core orchestrator for JTCAT.
 *
 * Manages:
 *  - 15-second decode cycles (FT8) / 7.5-second (FT4)
 *  - Audio buffer accumulation from any source
 *  - Decode via worker thread (ft8js WASM)
 *  - TX tone generation and scheduling
 *  - QSO state machine (Phase 3)
 *
 * Events emitted:
 *  - 'decode'    — { cycle, results: [{db, dt, df, text}] }
 *  - 'cycle'     — { number, mode, slot } — new decode cycle started
 *  - 'tx-audio'  — Float32Array of TX samples to send to radio
 *  - 'status'    — { state, sync, nextCycle }
 *  - 'error'     — { message }
 */

const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');
const path = require('path');

// FT8 digital mode frequencies (kHz) per band
const DIGITAL_FREQS = {
  '160m': 1840,
  '80m':  3573,
  '60m':  5357,
  '40m':  7074,
  '30m': 10136,
  '20m': 14074,
  '17m': 18100,
  '15m': 21074,
  '12m': 24915,
  '10m': 28074,
  '6m':  50313,
  '2m': 144174,
};

const SAMPLE_RATE = 12000;
const FT8_CYCLE_SEC = 15;
const FT4_CYCLE_SEC = 7.5;
const FT8_SAMPLES = SAMPLE_RATE * FT8_CYCLE_SEC; // 180,000

class Ft8Engine extends EventEmitter {
  constructor() {
    super();
    this._worker = null;
    this._workerReady = false;
    this._mode = 'FT8'; // 'FT8' | 'FT4'
    this._running = false;
    this._cycleTimer = null;
    this._cycleNumber = 0;
    this._msgId = 0;

    // Audio buffer accumulation
    this._audioBuffer = new Float32Array(FT8_SAMPLES);
    this._audioOffset = 0;

    // TX state
    this._txEnabled = false;
    this._txFreq = 1500; // Hz audio offset
    this._rxFreq = 1500;
    this._txMessage = '';
    this._txSlot = 'even'; // 'even' | 'odd'

    // Pending decode callbacks
    this._pending = new Map();
  }

  /**
   * Start the engine — spawns worker, begins cycle timing.
   */
  start() {
    if (this._running) return;
    this._running = true;
    this._spawnWorker();
    this._scheduleCycle();
    this.emit('status', { state: 'running', mode: this._mode });
  }

  /**
   * Stop the engine — kills worker, clears timers.
   */
  stop() {
    this._running = false;
    if (this._cycleTimer) {
      clearTimeout(this._cycleTimer);
      this._cycleTimer = null;
    }
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
      this._workerReady = false;
    }
    this._audioOffset = 0;
    this._pending.clear();
    this.emit('status', { state: 'stopped' });
  }

  /**
   * Feed audio samples into the engine.
   * Call this continuously as audio arrives from DAX or soundcard.
   * @param {Float32Array} samples — mono audio at 12000 Hz
   */
  feedAudio(samples) {
    if (!this._running) return;
    for (let i = 0; i < samples.length; i++) {
      this._audioBuffer[this._audioOffset] = samples[i];
      this._audioOffset++;
      if (this._audioOffset >= FT8_SAMPLES) {
        this._audioOffset = 0; // wrap — we'll grab the full buffer at cycle boundary
      }
    }
  }

  /**
   * Set mode: 'FT8' or 'FT4'
   */
  setMode(mode) {
    this._mode = mode === 'FT4' ? 'FT4' : 'FT8';
  }

  /**
   * Set TX audio frequency offset (Hz within passband).
   */
  setTxFreq(hz) {
    this._txFreq = Math.max(100, Math.min(3000, hz));
  }

  /**
   * Set RX audio frequency offset (Hz within passband).
   */
  setRxFreq(hz) {
    this._rxFreq = Math.max(100, Math.min(3000, hz));
  }

  /**
   * Encode a message for TX.
   * @param {string} text — FT8 message (e.g. "CQ K3SBP FN20")
   * @param {number} freq — audio frequency in Hz
   * @returns {Promise<Float32Array|null>}
   */
  async encodeMessage(text, freq) {
    if (!this._workerReady) throw new Error('FT8 worker not ready');
    const id = ++this._msgId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ type: 'encode', id, text, frequency: freq || this._txFreq });
    });
  }

  // --- Internal ---

  _spawnWorker() {
    const workerPath = path.join(__dirname, 'ft8-worker.js');
    this._worker = new Worker(workerPath);
    this._worker.on('message', (msg) => this._onWorkerMessage(msg));
    this._worker.on('error', (err) => {
      console.error('[JTCAT] Worker error:', err.message);
      this.emit('error', { message: err.message });
    });
    this._worker.on('exit', (code) => {
      if (this._running && code !== 0) {
        console.error(`[JTCAT] Worker exited with code ${code}, restarting...`);
        setTimeout(() => this._spawnWorker(), 1000);
      }
    });
  }

  _onWorkerMessage(msg) {
    if (msg.type === 'ready') {
      this._workerReady = true;
      console.log('[JTCAT] FT8 worker ready');
      return;
    }
    if (msg.type === 'decode-result') {
      this._cycleNumber++;
      this.emit('decode', {
        cycle: this._cycleNumber,
        mode: this._mode,
        results: msg.results || [],
      });
      return;
    }
    if (msg.type === 'encode-result') {
      const cb = this._pending.get(msg.id);
      if (cb) {
        this._pending.delete(msg.id);
        cb.resolve(msg.samples ? new Float32Array(msg.samples) : null);
      }
      return;
    }
    if (msg.type === 'error') {
      const cb = this._pending.get(msg.id);
      if (cb) {
        this._pending.delete(msg.id);
        cb.reject(new Error(msg.message));
      } else {
        this.emit('error', { message: msg.message });
      }
    }
  }

  /**
   * Schedule decode cycles aligned to 15-second (FT8) or 7.5-second (FT4) boundaries.
   */
  _scheduleCycle() {
    if (!this._running) return;

    const now = Date.now();
    const cycleSec = this._mode === 'FT4' ? FT4_CYCLE_SEC : FT8_CYCLE_SEC;
    const cycleMs = cycleSec * 1000;

    // Time until next cycle boundary
    const msIntoCurrentCycle = now % cycleMs;
    // Trigger decode ~0.5s after cycle boundary to allow for propagation delay
    const delay = cycleMs - msIntoCurrentCycle + 500;

    this._cycleTimer = setTimeout(() => {
      this._onCycleBoundary();
      this._scheduleCycle(); // schedule next
    }, delay);
  }

  _onCycleBoundary() {
    if (!this._running || !this._workerReady) return;

    const now = Date.now();
    const cycleSec = this._mode === 'FT4' ? FT4_CYCLE_SEC : FT8_CYCLE_SEC;
    const slot = Math.floor(now / 1000 / cycleSec) % 2 === 0 ? 'even' : 'odd';

    this.emit('cycle', { number: this._cycleNumber + 1, mode: this._mode, slot });

    // Grab current audio buffer and send to worker for decode
    const samples = new Float32Array(this._audioBuffer);
    this._worker.postMessage(
      { type: 'decode', id: ++this._msgId, samples: samples.buffer },
      [samples.buffer]
    );

    // Allocate new buffer (old one was transferred)
    this._audioBuffer = new Float32Array(FT8_SAMPLES);
    this._audioOffset = 0;
  }

  /**
   * Get standard digital frequencies for band buttons.
   */
  static get DIGITAL_FREQS() {
    return DIGITAL_FREQS;
  }
}

module.exports = { Ft8Engine, DIGITAL_FREQS, SAMPLE_RATE };
