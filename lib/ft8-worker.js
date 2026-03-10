/**
 * FT8 decode/encode worker thread.
 * Runs ft8js (ESM/WASM) in an isolated thread to avoid blocking the main process.
 *
 * Messages IN:
 *   { type: 'decode', id, samples: Float32Array }
 *   { type: 'encode', id, text: string, frequency: number }
 *
 * Messages OUT:
 *   { type: 'decode-result', id, results: [{db, dt, df, text}] }
 *   { type: 'encode-result', id, samples: Float32Array | null }
 *   { type: 'error', id, message: string }
 *   { type: 'ready' }
 */

const { parentPort } = require('worker_threads');

let decode, encode;

async function init() {
  try {
    const ft8 = await import('ft8js');
    decode = ft8.decode;
    encode = ft8.encode;
    parentPort.postMessage({ type: 'ready' });
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: 0, message: 'Failed to load ft8js: ' + err.message });
  }
}

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'decode') {
      if (!decode) {
        parentPort.postMessage({ type: 'error', id: msg.id, message: 'ft8js not loaded yet' });
        return;
      }
      const samples = new Float32Array(msg.samples);
      const results = await decode(samples);
      parentPort.postMessage({ type: 'decode-result', id: msg.id, results });
    } else if (msg.type === 'encode') {
      if (!encode) {
        parentPort.postMessage({ type: 'error', id: msg.id, message: 'ft8js not loaded yet' });
        return;
      }
      const samples = await encode(msg.text, msg.frequency);
      if (samples) {
        const buf = samples.buffer;
        parentPort.postMessage(
          { type: 'encode-result', id: msg.id, samples },
          [buf]
        );
      } else {
        parentPort.postMessage({ type: 'encode-result', id: msg.id, samples: null });
      }
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: err.message });
  }
});

init();
