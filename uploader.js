/* Write-only uploader for the shared Supabase pile.
   Splits a big export into numbered chunks and inserts them; it can never
   read, edit or delete, because the key's RLS policy only grants INSERT. */
(function (global) {
  'use strict';

  // Chunks are measured in UTF-8 bytes and stay well under the 200k-character
  // ceiling the RLS policy enforces (a byte count is always >= the char count).
  const CHUNK_BYTES = 150000;
  const REQUEST_BYTES = 900000;   // rough cap per POST

  const encoder = new TextEncoder();
  const bytes = (s) => encoder.encode(s).length;

  function configured() {
    const c = global.APPENDER_CONFIG;
    return !!(c && c.supabaseUrl && c.supabaseAnonKey &&
      !c.supabaseUrl.includes('YOUR-PROJECT-REF') && !c.supabaseAnonKey.includes('YOUR-ANON'));
  }

  // Split on line boundaries so a message never gets cut in half. A single line
  // longer than a chunk falls back to slicing, without breaking a surrogate pair.
  function chunk(text) {
    const out = [];
    let buf = '', bufBytes = 0;
    const flush = () => { if (buf) { out.push(buf); buf = ''; bufBytes = 0; } };

    for (const line of text.split(/(?<=\n)/)) {
      const n = bytes(line);
      if (n <= CHUNK_BYTES) {
        if (bufBytes + n > CHUNK_BYTES) flush();
        buf += line; bufBytes += n;
        continue;
      }
      flush();
      const step = Math.floor(CHUNK_BYTES / 4);
      for (let i = 0; i < line.length;) {
        let end = Math.min(i + step, line.length);
        const c = line.charCodeAt(end - 1);
        if (end < line.length && c >= 0xd800 && c <= 0xdbff) end -= 1;
        out.push(line.slice(i, end));
        i = end;
      }
    }
    flush();
    return out.length ? out : [text];
  }

  /* There is deliberately no per-browser memory of what has been sent. It would
     be faster, but it can disagree with the database — delete a row in the
     dashboard and the browser would keep insisting the file was already shared,
     so it could never be re-uploaded. The unique index on (content_hash, part)
     is the only thing that decides what is a duplicate. */

  const hex = (bytes) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

  /* crypto.subtle only exists in a secure context, so a page served over a plain
     http:// LAN address has no digest at all. Fall back to a JS implementation
     so sharing still works there, and so both paths produce the same hash for
     the same text — otherwise the same export would upload twice. */
  function sha256js(text) {
    const K = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    let h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];

    const msg = encoder.encode(text);
    const bitLen = msg.length * 8;
    const withPad = new Uint8Array(((msg.length + 72) >> 6) << 6);   // len + 0x80 + 8-byte length, up to a multiple of 64
    withPad.set(msg);
    withPad[msg.length] = 0x80;
    const dv = new DataView(withPad.buffer);
    // Length is 64-bit; the high word covers inputs over 512 MB, which cannot occur here.
    dv.setUint32(withPad.length - 8, Math.floor(bitLen / 4294967296));
    dv.setUint32(withPad.length - 4, bitLen >>> 0);

    const w = new Uint32Array(64);
    const rr = (x, n) => (x >>> n) | (x << (32 - n));

    for (let i = 0; i < withPad.length; i += 64) {
      for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
      for (let t = 16; t < 64; t++) {
        const s0 = rr(w[t-15], 7) ^ rr(w[t-15], 18) ^ (w[t-15] >>> 3);
        const s1 = rr(w[t-2], 17) ^ rr(w[t-2], 19) ^ (w[t-2] >>> 10);
        w[t] = (w[t-16] + s0 + w[t-7] + s1) >>> 0;
      }
      let [a,b,c,d,e,f,g,hh] = h;
      for (let t = 0; t < 64; t++) {
        const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
        const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h = [h[0]+a, h[1]+b, h[2]+c, h[3]+d, h[4]+e, h[5]+f, h[6]+g, h[7]+hh].map(x => x >>> 0);
    }
    return h.map(x => x.toString(16).padStart(8, '0')).join('');
  }

  async function sha256(text) {
    if (global.crypto && global.crypto.subtle) {
      try {
        return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
      } catch (e) { /* fall through to the JS implementation */ }
    }
    return sha256js(text);
  }

  // crypto.randomUUID is secure-context only too; getRandomValues is not.
  function uuid() {
    if (global.crypto && global.crypto.randomUUID) {
      try { return crypto.randomUUID(); } catch (e) { /* fall through */ }
    }
    const b = new Uint8Array(16);
    (global.crypto || {}).getRandomValues
      ? crypto.getRandomValues(b)
      : b.forEach((_, i) => { b[i] = Math.floor(Math.random() * 256); });
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const s = hex(b);
    return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
  }

  async function post(cfg, rows) {
    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${cfg.table || 'notes'}`, {
      method: 'POST',
      headers: {
        'apikey': cfg.supabaseAnonKey,
        'Authorization': `Bearer ${cfg.supabaseAnonKey}`,
        'Content-Type': 'application/json',
        // The key has no SELECT rights, so don't ask for the rows back.
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(rows)
    });
    if (!res.ok) {
      const err = new Error(`failed (${res.status})`);
      err.status = res.status;
      err.body = (await res.text().catch(() => '')).slice(0, 500);
      throw err;
    }
  }

  /* Records the outcome where the reader can stay silent about it. Best effort
     and deliberately un-awaited: a share must never fail because its log did,
     and a log must never be the thing that shows an error on screen. Note the
     obvious gap — if the network is down, the log cannot land either. */
  function logShare(cfg, row) {
    try {
      fetch(`${cfg.supabaseUrl}/rest/v1/share_log`, {
        method: 'POST',
        headers: {
          'apikey': cfg.supabaseAnonKey,
          'Authorization': `Bearer ${cfg.supabaseAnonKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(Object.assign({
          page_url: String(location.href).slice(0, 500),
          user_agent: String(navigator.userAgent).slice(0, 400)
        }, row)),
        keepalive: true          // survives the tab being closed right after
      }).catch(() => {});
    } catch (e) { /* never let logging surface */ }
  }

  /* Insert a batch, treating chunks that are already in the table as done.
     409 means the unique index on (content_hash, part) rejected the batch, so
     re-dropping the same export is a no-op and a half-finished upload resumes.
     Postgres fails the whole statement on one duplicate, hence the per-row retry.
     Returns how many rows were newly written. */
  async function postSkippingDuplicates(cfg, rows) {
    try {
      await post(cfg, rows);
      return rows.length;
    } catch (err) {
      if (err.status !== 409) throw err;
    }
    let written = 0;
    for (const row of rows) {
      try {
        await post(cfg, [row]);
        written++;
      } catch (err) {
        if (err.status !== 409) throw err;   // a real failure, not a duplicate
      }
    }
    return written;
  }

  /* upload({ filename, text, onProgress })
     onProgress(done, total) is called per request; resolves with a summary. */
  async function upload(opts) {
    const cfg = global.APPENDER_CONFIG;
    if (!configured()) throw new Error('Sharing is not configured (config.js).');

    const text = opts.text || '';
    if (!text.trim()) throw new Error('Nothing to share.');

    const hash = await sha256(text);
    const pieces = chunk(text);
    const batchId = uuid();

    const rows = pieces.map((content, i) => ({
      filename: (opts.filename || 'chat.txt').slice(0, 260),
      content,
      byte_size: bytes(content),
      batch_id: batchId,
      part: i + 1,
      parts: pieces.length,
      content_hash: hash
    }));

    const batches = [];
    let current = [], currentBytes = 0;
    for (const r of rows) {
      if (current.length && currentBytes + r.byte_size > REQUEST_BYTES) {
        batches.push(current); current = []; currentBytes = 0;
      }
      current.push(r); currentBytes += r.byte_size;
    }
    if (current.length) batches.push(current);

    const startedAt = Date.now();
    let done = 0, written = 0;
    for (const batch of batches) {
      if (opts.onProgress) opts.onProgress(done, pieces.length);
      try {
        written += await postSkippingDuplicates(cfg, batch);
      } catch (err) {
        err.done = done;
        err.total = pieces.length;
        logShare(cfg, {
          status: 'failed',
          filename: rows[0].filename,
          content_hash: hash,
          batch_id: batchId,
          parts: pieces.length,
          written,
          duration_ms: Date.now() - startedAt,
          error: `${err.message} after ${done}/${pieces.length} parts${err.body ? ' — ' + err.body : ''}`.slice(0, 2000)
        });
        throw err;
      }
      done += batch.length;
    }
    if (opts.onProgress) opts.onProgress(done, pieces.length);

    logShare(cfg, {
      status: 'ok',
      filename: rows[0].filename,
      content_hash: hash,
      batch_id: batchId,
      parts: pieces.length,
      written,
      duration_ms: Date.now() - startedAt
    });
    return { parts: pieces.length, written, hash, batchId };
  }

  global.Appender = { upload, configured };
})(window);
