/* Lazy, dependency-free ZIP reader.
   Reads the central directory by slicing the tail of the File, then decompresses
   individual entries on demand with DecompressionStream('deflate-raw').
   Never loads the whole archive into memory -> multi-GB WhatsApp exports are fine. */
(function (global) {
  'use strict';

  const EOCD_SIG = 0x06054b50;
  const EOCD64_LOC_SIG = 0x07064b50;
  const EOCD64_SIG = 0x06064b50;
  const CEN_SIG = 0x02014b50;

  async function sliceBuf(file, start, end) {
    const s = Math.max(0, start);
    const e = Math.min(file.size, end);
    return new DataView(await file.slice(s, e).arrayBuffer());
  }

  function readString(dv, off, len) {
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset + off, len);
    // WhatsApp writes UTF-8 names; fall back gracefully either way.
    return new TextDecoder('utf-8').decode(bytes);
  }

  class ZipEntry {
    constructor(zip, o) { Object.assign(this, o); this._zip = zip; }
    get isDir() { return this.name.endsWith('/'); }

    async bytes() {
      const zip = this._zip;
      // Local header is 30 bytes + name + extra; its lengths can differ from central.
      const head = await sliceBuf(zip.file, this.localOffset, this.localOffset + 30);
      if (head.getUint32(0, true) !== 0x04034b50) throw new Error('bad local header for ' + this.name);
      const nameLen = head.getUint16(26, true);
      const extraLen = head.getUint16(28, true);
      const start = this.localOffset + 30 + nameLen + extraLen;
      const blob = zip.file.slice(start, start + this.compressedSize);
      if (this.method === 0) return new Uint8Array(await blob.arrayBuffer());
      if (this.method !== 8) throw new Error('unsupported compression method ' + this.method);
      const ds = new DecompressionStream('deflate-raw');
      const out = blob.stream().pipeThrough(ds);
      return new Uint8Array(await new Response(out).arrayBuffer());
    }

    async blob(type) {
      return new Blob([await this.bytes()], { type: type || '' });
    }

    async text() {
      const b = await this.bytes();
      // Strip UTF-8 / UTF-16 BOMs that some exports carry.
      if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
      if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
      return new TextDecoder('utf-8').decode(b).replace(/^﻿/, '');
    }
  }

  class Zip {
    constructor(file) { this.file = file; this.entries = []; }

    async open() {
      const tailLen = Math.min(this.file.size, 66560); // 64KB comment + headroom
      const dv = await sliceBuf(this.file, this.file.size - tailLen, this.file.size);
      let eocd = -1;
      for (let i = dv.byteLength - 22; i >= 0; i--) {
        if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record).');

      let count = dv.getUint16(eocd + 10, true);
      let cenSize = dv.getUint32(eocd + 12, true);
      let cenOffset = dv.getUint32(eocd + 16, true);

      // ZIP64 (exports > 4GB, or > 65535 files)
      if (cenOffset === 0xffffffff || count === 0xffff || cenSize === 0xffffffff) {
        const locOff = eocd - 20;
        if (locOff >= 0 && dv.getUint32(locOff, true) === EOCD64_LOC_SIG) {
          const eocd64At = Number(dv.getBigUint64(locOff + 8, true));
          const z = await sliceBuf(this.file, eocd64At, eocd64At + 56);
          if (z.getUint32(0, true) === EOCD64_SIG) {
            count = Number(z.getBigUint64(32, true));
            cenSize = Number(z.getBigUint64(40, true));
            cenOffset = Number(z.getBigUint64(48, true));
          }
        }
      }

      const cen = await sliceBuf(this.file, cenOffset, cenOffset + cenSize);
      let p = 0;
      for (let i = 0; i < count && p + 46 <= cen.byteLength; i++) {
        if (cen.getUint32(p, true) !== CEN_SIG) break;
        const flags = cen.getUint16(p + 8, true);
        const method = cen.getUint16(p + 10, true);
        const dosTime = cen.getUint16(p + 12, true);
        const dosDate = cen.getUint16(p + 14, true);
        let compressedSize = cen.getUint32(p + 20, true);
        let size = cen.getUint32(p + 24, true);
        const nameLen = cen.getUint16(p + 28, true);
        const extraLen = cen.getUint16(p + 30, true);
        const commentLen = cen.getUint16(p + 32, true);
        let localOffset = cen.getUint32(p + 42, true);
        let name = readString(cen, p + 46, nameLen);
        if (!(flags & 0x800)) {
          // Not UTF-8 flagged; latin1 is the safer legacy guess.
          const raw = new Uint8Array(cen.buffer, cen.byteOffset + p + 46, nameLen);
          name = new TextDecoder('windows-1252').decode(raw);
        }

        // ZIP64 extended info field
        if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
          let e = p + 46 + nameLen;
          const extraEnd = e + extraLen;
          while (e + 4 <= extraEnd) {
            const hid = cen.getUint16(e, true);
            const hlen = cen.getUint16(e + 2, true);
            if (hid === 0x0001) {
              let q = e + 4;
              if (size === 0xffffffff) { size = Number(cen.getBigUint64(q, true)); q += 8; }
              if (compressedSize === 0xffffffff) { compressedSize = Number(cen.getBigUint64(q, true)); q += 8; }
              if (localOffset === 0xffffffff) { localOffset = Number(cen.getBigUint64(q, true)); q += 8; }
              break;
            }
            e += 4 + hlen;
          }
        }

        this.entries.push(new ZipEntry(this, {
          name, method, compressedSize, size, localOffset,
          date: dosToDate(dosDate, dosTime)
        }));
        p += 46 + nameLen + extraLen + commentLen;
      }
      return this;
    }
  }

  function dosToDate(d, t) {
    try {
      return new Date(1980 + ((d >> 9) & 0x7f), ((d >> 5) & 0x0f) - 1, d & 0x1f,
        (t >> 11) & 0x1f, (t >> 5) & 0x3f, (t & 0x1f) * 2);
    } catch (_) { return null; }
  }

  global.Zip = Zip;
})(window);
