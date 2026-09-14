/* WhatsApp export (.txt) parser. Handles Android and iOS formats,
   12h/24h clocks, dd/mm vs mm/dd ambiguity, multi-line messages,
   system messages and media attachment markers. */
(function (global) {
  'use strict';

  // Invisible marks WhatsApp sprinkles into exports (LRM/RLM/LTR marks, NBSP).
  const INVIS = /[‎‏‪-‮⁦-⁩]/g;
  const clean = (s) => s.replace(INVIS, '').replace(/ /g, ' ');

  // [12/01/2023, 11:04:52 PM] Name: text     (iOS)
  // 12/01/2023, 23:04 - Name: text          (Android)
  // 2023-01-12, 23:04 - Name: text          (some locales)
  const HEAD = new RegExp(
    '^\\[?\\s*' +
    '(\\d{1,4})[./-](\\d{1,2})[./-](\\d{2,4})' +          // 1,2,3 date parts
    '[,\\s]+' +
    '(\\d{1,2}):(\\d{2})(?::(\\d{2}))?' +                 // 4,5,6 time
    '\\s*([APap]\\.?[Mm]\\.?)?' +                         // 7 meridiem
    '\\s*\\]?\\s*(?:-\\s*)?' +                            // separator
    '([\\s\\S]*)$'                                        // 8 remainder
  );

  const MEDIA_PATTERNS = [
    /^<attached:\s*(.+?)>$/i,                    // iOS
    /^(.+?)\s*\(file attached\)$/i,              // Android
    /^(.+?)\s+<attached>$/i
  ];

  const OMITTED = /^(?:‎)?(?:image|video|audio|sticker|gif|document|contact card)?\s*(?:omitted|<media omitted>)$/i;

  function splitSender(rest) {
    // Sender names never contain a newline and are short-ish; system messages have no "Name: ".
    const nl = rest.indexOf('\n');
    const firstLine = nl === -1 ? rest : rest.slice(0, nl);
    const idx = firstLine.indexOf(': ');
    if (idx === -1) return { sender: null, text: rest };
    const name = firstLine.slice(0, idx);
    if (name.length === 0 || name.length > 100) return { sender: null, text: rest };
    return { sender: name.trim(), text: rest.slice(idx + 2) };
  }

  function detectMedia(text) {
    const t = text.trim();
    for (const re of MEDIA_PATTERNS) {
      const m = t.match(re);
      if (m) return { file: m[1].trim(), caption: '' };
    }
    // Android puts a caption on the line after "IMG-x.jpg (file attached)"
    const lines = t.split('\n');
    if (lines.length > 1) {
      for (const re of MEDIA_PATTERNS) {
        const m = lines[0].trim().match(re);
        if (m) return { file: m[1].trim(), caption: lines.slice(1).join('\n') };
      }
    }
    return null;
  }

  function parse(raw) {
    const text = clean(raw).replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const rows = [];

    for (const line of lines) {
      const m = line.match(HEAD);
      if (m) {
        rows.push({ parts: m, rest: m[8] });
      } else if (rows.length) {
        rows[rows.length - 1].rest += '\n' + line;
      } else if (line.trim()) {
        rows.push({ parts: null, rest: line });
      }
    }

    // Resolve dd/mm vs mm/dd across the whole file before building dates.
    let dayFirst = true;
    let aMax = 0, bMax = 0;
    for (const r of rows) {
      if (!r.parts) continue;
      const a = +r.parts[1], b = +r.parts[2];
      if (a > aMax) aMax = a;
      if (b > bMax) bMax = b;
    }
    const isoStyle = rows.some(r => r.parts && r.parts[1].length === 4);
    if (isoStyle) dayFirst = false;
    else if (aMax > 12) dayFirst = true;
    else if (bMax > 12) dayFirst = false;

    const messages = [];
    for (const r of rows) {
      if (!r.parts) {
        messages.push({ ts: null, sender: null, text: r.rest, system: true, media: null });
        continue;
      }
      const p = r.parts;
      let y, mo, d;
      if (isoStyle) { y = +p[1]; mo = +p[2]; d = +p[3]; }
      else if (dayFirst) { d = +p[1]; mo = +p[2]; y = +p[3]; }
      else { mo = +p[1]; d = +p[2]; y = +p[3]; }
      if (y < 100) y += y < 70 ? 2000 : 1900;

      let h = +p[4];
      const mi = +p[5];
      const se = p[6] ? +p[6] : 0;
      const mer = p[7] ? p[7].toLowerCase().replace(/\./g, '') : null;
      if (mer === 'pm' && h < 12) h += 12;
      if (mer === 'am' && h === 12) h = 0;

      const ts = new Date(y, mo - 1, d, h, mi, se).getTime();
      const { sender, text: body } = splitSender(r.rest);
      const media = sender ? detectMedia(body) : null;

      const omitted = !media && OMITTED.test(body.trim());
      messages.push({
        ts: isNaN(ts) ? null : ts,
        sender,
        text: media ? media.caption : (omitted ? '' : body),
        media: media ? media.file : null,
        omitted,
        system: !sender
      });
    }

    const senders = new Map();
    for (const m of messages) {
      if (!m.sender) continue;
      senders.set(m.sender, (senders.get(m.sender) || 0) + 1);
    }

    return {
      messages,
      participants: [...senders.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      dayFirst
    };
  }

  global.WAParser = { parse };
})(window);
