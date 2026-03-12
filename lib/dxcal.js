// danplanet DXpedition iCal feed — fetch + parse active expeditions
const https = require('https');

const DXCAL_URL = 'https://www.danplanet.com/dxcal.ics';

// Standard callsign regex: 1-2 letter/digit prefix, digit, 1-3 letter suffix, optional /suffix
const CALLSIGN_RE = /\b([A-Z]{1,2}[0-9][A-Z0-9]{0,3}[A-Z])\b/g;

/**
 * Fetch and parse the danplanet iCal feed, returning currently-active expeditions.
 * @returns {Promise<Array<{callsigns: string[], entity: string, startDate: string, endDate: string, description: string}>>}
 */
function fetchDxCalExpeditions() {
  return new Promise((resolve, reject) => {
    https.get(DXCAL_URL, { headers: { 'User-Agent': 'POTACAT/1.0' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(parseIcal(body));
        } catch (e) {
          reject(new Error('Failed to parse iCal: ' + e.message));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Parse iCal text, filter to active events, extract callsigns + metadata.
 */
function parseIcal(text) {
  // Unfold iCal continuation lines (line starts with space or tab)
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');

  const events = [];
  const blocks = unfolded.split('BEGIN:VEVENT');

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('END:VEVENT')[0];
    if (!block) continue;

    const fields = {};
    for (const line of block.split(/\r?\n/)) {
      // iCal fields: NAME;PARAMS:VALUE or NAME:VALUE
      const m = line.match(/^([A-Z][A-Z0-9_-]*)(;[^:]*)?:(.*)/);
      if (m) fields[m[1]] = m[3];
    }

    const summary = unescapeIcal(fields.SUMMARY || '');
    const description = unescapeIcal(fields.DESCRIPTION || '');
    const dtstart = fields.DTSTART;
    const dtend = fields.DTEND;

    if (!dtstart) continue;

    // Parse DATE values (YYYYMMDD)
    const startDate = parseIcalDate(dtstart);
    const endDate = dtend ? parseIcalDate(dtend) : startDate;
    if (!startDate) continue;

    // Active filter: startDate - 1 day <= today <= endDate + 1 day
    const grace = 86400000; // 1 day in ms
    if (today.getTime() < startDate.getTime() - grace) continue;
    if (today.getTime() > endDate.getTime() + grace) continue;

    // Extract DXCC entity from SUMMARY parenthetical: "Entity Name (PREFIX)"
    const entityMatch = summary.match(/^(.+?)\s*\(/);
    const entity = entityMatch ? entityMatch[1].trim() : '';

    // Extract callsigns
    const callsigns = extractCallsigns(summary, description);
    if (callsigns.length === 0) continue;

    events.push({
      callsigns,
      entity,
      startDate: formatDate(startDate),
      endDate: formatDate(endDate),
      description: description.substring(0, 200),
    });
  }

  return events;
}

/**
 * Extract callsigns from SUMMARY and DESCRIPTION.
 * Primary: parenthetical in SUMMARY like "(T8OK)"
 * Secondary: "as CALLSIGN" patterns and standard callsign regex in DESCRIPTION
 */
function extractCallsigns(summary, description) {
  const calls = new Set();

  // From SUMMARY parenthetical — often just a prefix, but sometimes a full callsign
  const parenMatch = summary.match(/\(([^)]+)\)/);
  // "as CALLSIGN" patterns in DESCRIPTION
  const asMatches = description.matchAll(/\bas\s+([A-Z0-9/]{3,})/gi);
  for (const m of asMatches) {
    const c = m[1].toUpperCase();
    if (c.match(/^[A-Z0-9]{1,2}[0-9][A-Z0-9]*[A-Z]$/)) calls.add(c);
    // Handle portable calls like V4/K0YA
    if (c.includes('/')) calls.add(c);
  }

  // Standard callsign regex on first part of description (before first semicolon or "fm")
  const firstPart = description.split(/[;]|(?:\bfm\b)/i)[0] || '';
  const regexMatches = firstPart.matchAll(CALLSIGN_RE);
  for (const m of regexMatches) {
    calls.add(m[1]);
  }

  // Also grab portable-style calls like PJ2/W2APF
  const portableMatches = description.matchAll(/\b([A-Z0-9]{1,4}\/[A-Z]{1,2}[0-9][A-Z0-9]*[A-Z])\b/gi);
  for (const m of portableMatches) {
    calls.add(m[1].toUpperCase());
  }

  // Reverse portable: W2APF/PJ2
  const revPortableMatches = description.matchAll(/\b([A-Z]{1,2}[0-9][A-Z0-9]*[A-Z]\/[A-Z0-9]{1,4})\b/gi);
  for (const m of revPortableMatches) {
    calls.add(m[1].toUpperCase());
  }

  return [...calls];
}

function unescapeIcal(str) {
  return str.replace(/\\;/g, ';').replace(/\\,/g, ',').replace(/\\n/gi, '\n').replace(/\\\\/g, '\\');
}

function parseIcalDate(str) {
  // Handle YYYYMMDD format
  const m = str.match(/(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = { fetchDxCalExpeditions };
