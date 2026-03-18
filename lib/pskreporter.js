// PSKReporter HTTP client — polls live FreeDV reception reports
// The MQTT feed at mqtt.pskreporter.info does NOT carry FreeDV spots,
// so we poll the XML API at retrieve.pskreporter.info instead.
const https = require('https');
const { EventEmitter } = require('events');
const { freqToBand } = require('./bands');

const QUERY_URL = 'https://retrieve.pskreporter.info/query';
const POLL_INTERVAL = 300000; // 5 minutes between polls (API rate-limits aggressively)
const BACKOFF_INTERVAL = 600000; // 10 minutes after a 503

class PskrClient extends EventEmitter {
  constructor() {
    super();
    this._pollTimer = null;
    this._active = false;
    this.connected = false;
    this.nextPollAt = null; // timestamp (ms) of next scheduled poll
  }

  connect(config = {}) {
    this.disconnect();
    this._config = config;
    this._active = true;
    this._poll();
  }

  _poll() {
    if (!this._active) return;

    // If senderCallsign is set, query by sender (PSKReporter Map view — all modes);
    // otherwise fall back to FreeDV-only mode (existing behavior)
    let url;
    if (this._config && this._config.senderCallsign) {
      const call = encodeURIComponent(this._config.senderCallsign);
      url = `${QUERY_URL}?senderCallsign=${call}&flowStartSeconds=-900&rronly=1&rptlimit=500&appcontact=potacat-app`;
    } else {
      url = `${QUERY_URL}?mode=FREEDV&flowStartSeconds=-900&rronly=1&rptlimit=100&appcontact=potacat-app`;
    }

    const label = (this._config && this._config.senderCallsign) ? `spots for ${this._config.senderCallsign}` : 'FreeDV spots';
    this.emit('log', `PSKReporter: fetching ${label}...`);
    const req = https.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'POTACAT/0.9.7 (Electron)' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (!this._active) return;

        if (res.statusCode === 200) {
          const wasDisconnected = !this.connected;
          this.connected = true;
          this._parseXml(body);
          this._schedulePoll(POLL_INTERVAL);
          // Emit status AFTER parseXml and schedulePoll so spot count + nextPollAt are accurate
          if (wasDisconnected) {
            this.emit('status', { connected: true });
          }
          this.emit('pollDone');
        } else if (res.statusCode === 503) {
          this.emit('error', 'PSKReporter: rate limited, backing off');
          this._schedulePoll(BACKOFF_INTERVAL);
        } else {
          this.emit('error', `PSKReporter HTTP ${res.statusCode}`);
          if (this.connected) {
            this.connected = false;
            this.emit('status', { connected: false });
          }
          this._schedulePoll(POLL_INTERVAL);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
    });

    req.on('error', (err) => {
      if (!this._active) return;
      this.emit('error', `PSKReporter: ${err.message}`);
      if (this.connected) {
        this.connected = false;
        this.emit('status', { connected: false });
      }
      this._schedulePoll(BACKOFF_INTERVAL);
    });
  }

  _schedulePoll(interval) {
    if (!this._active || this._pollTimer) return;
    this.nextPollAt = Date.now() + interval;
    this._pollTimer = setTimeout(() => {
      this._pollTimer = null;
      this.nextPollAt = null;
      this._poll();
    }, interval);
  }

  _parseXml(xml) {
    const reportRe = /<receptionReport\s+([^/>]+)\/>/g;
    let m;
    while ((m = reportRe.exec(xml)) !== null) {
      const attrs = m[1];
      const get = (name) => {
        const am = attrs.match(new RegExp(`${name}="([^"]*)"`));
        return am ? am[1] : '';
      };

      const callsign = get('senderCallsign');
      const spotter = get('receiverCallsign');
      const freqHz = parseInt(get('frequency'), 10);
      if (!callsign || !freqHz) continue;

      const freqKhz = freqHz / 1000;
      const freqMHz = freqHz / 1e6;
      const band = freqToBand(freqMHz) || '';
      const snr = get('sNR') ? parseInt(get('sNR'), 10) : null;

      const flowStart = parseInt(get('flowStartSeconds'), 10);
      const spotTime = flowStart
        ? new Date(flowStart * 1000).toISOString()
        : new Date().toISOString();

      this.emit('spot', {
        callsign,
        spotter,
        frequency: String(Math.round(freqKhz * 10) / 10),
        freqMHz,
        mode: (get('mode') || 'FREEDV').toUpperCase(),
        band,
        snr,
        senderGrid: get('senderLocator'),
        receiverGrid: get('receiverLocator'),
        spotTime,
      });
    }
  }

  disconnect() {
    this._active = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this.connected = false;
  }
}

module.exports = { PskrClient };
