import { closeSync, openSync, writeSync } from "node:fs";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

const BLOCK = 512;
const text = (b: Buffer, from: number, len: number) => { const s = b.subarray(from, from + len); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString("utf8"); };
const octal = (b: Buffer, from: number, len: number) => { const t = text(b, from, len).trim(); return t ? parseInt(t, 8) : 0; };

function paxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < data.length) {
    const sp = data.indexOf(0x20, at);
    if (sp < 0) break;
    const len = Number(data.subarray(at, sp).toString("ascii"));
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = data.subarray(sp + 1, at + len - 1).toString("utf8"), eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    at += len;
  }
  return out;
}

/** What to do with a file's bytes: skip them, keep them in memory for `onFile`, or write them straight to a path (for big files). */
export type TarWant = boolean | { toFile: string };

/**
 * Reads a .tar.gz as it arrives, without writing the archive to disk. `want` decides, from the name and size, what happens to each
 * file's bytes; `onFile` is then called with them (empty when they went to a file). Handles the long-name forms GitHub, npm and GNU tar
 * use. Returns how many files were handed over.
 */
export async function readTarGz(input: Readable, want: (name: string, size: number) => TarWant, onFile: (name: string, data: Buffer) => void | Promise<void>): Promise<number> {
  const gunzip = input.pipe(createGunzip());
  input.on("error", e => gunzip.destroy(e));
  let buf: Buffer = Buffer.alloc(0), given = 0;
  let head: { name: string; size: number; type: string; meta: boolean } | null = null;
  let left = 0, got = 0, mode: TarWant = false, parts: Buffer[] = [], fd = -1;
  let pendingName: string | null = null, globalPax: Record<string, string> = {}, pendingPax: Record<string, string> = {};
  let ended = false;
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (ended) break;
        if (!head) {
          if (buf.length < BLOCK) break;
          const h = buf.subarray(0, BLOCK); buf = buf.subarray(BLOCK);
          if (h.every(x => x === 0)) { ended = true; break; }
          let name = text(h, 0, 100);
          const prefix = text(h, 345, 155);
          if (prefix && h.subarray(257, 262).toString("ascii") === "ustar") name = `${prefix}/${name}`;
          const type = String.fromCharCode(h[156] || 0x30);
          const meta = type === "x" || type === "g" || type === "L";
          const size = !meta && pendingPax.size !== undefined ? Number(pendingPax.size) : octal(h, 124, 12);
          head = { name, size, type, meta };
          left = Math.ceil(size / BLOCK) * BLOCK; got = 0; parts = [];
          const finalName = pendingPax.path ?? pendingName ?? name;
          mode = meta ? size < 1_000_000 : (type === "0" || type === "\0") ? want(finalName, size) : false;
          if (typeof mode === "object") fd = openSync(mode.toFile, "w");
        }
        if (left > 0) {
          if (!buf.length) break;
          const take = Math.min(buf.length, left), real = Math.min(take, Math.max(0, head!.size - got));
          if (real > 0) {
            if (typeof mode === "object") writeSync(fd, buf, 0, real);
            else if (mode) parts.push(buf.subarray(0, real));
          }
          got += real; buf = buf.subarray(take); left -= take;
          if (left > 0) break;
        }
        // the entry is complete
        if (fd >= 0) { closeSync(fd); fd = -1; }
        const data = mode === true ? Buffer.concat(parts) : Buffer.alloc(0);
        if (head!.type === "x") pendingPax = { ...globalPax, ...paxRecords(data) };
        else if (head!.type === "g") globalPax = { ...globalPax, ...paxRecords(data) };
        else if (head!.type === "L") pendingName = text(data, 0, data.length);
        else {
          const finalName = pendingPax.path ?? pendingName ?? head!.name;
          if (mode) { await onFile(finalName, data); given++; }
          pendingName = null; pendingPax = {};
        }
        head = null; parts = [];
      }
      if (ended) { gunzip.destroy(); break; }
    }
  } finally { if (fd >= 0) { try { closeSync(fd); } catch { /* ignore */ } } }
  return given;
}

// ---- writing

/** One 512-byte ustar header (names longer than 100 characters use the prefix field). */
function header(name: string, size: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  let n = name, prefix = "";
  if (Buffer.byteLength(n) > 100) {
    const cut = n.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(n.slice(cut + 1)) > 100) throw new Error(`The file name is too long for the archive: ${name.slice(0, 40)}…`);
    prefix = n.slice(0, cut); n = n.slice(cut + 1);
  }
  h.write(n, 0, 100, "utf8"); h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124); h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136);
  h.write("        ", 148); h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263); h.write(prefix, 345, 155, "utf8");
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

export type TarSource = { name: string; data: Buffer } | { name: string; file: string; size: number };

/** Produces an uncompressed tar as a stream of buffers. Files are read in pieces, so large ones do not fill memory. */
export async function* tarChunks(entries: TarSource[], readFile: (path: string) => AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  for (const e of entries) {
    const size = "data" in e ? e.data.length : e.size;
    yield header(e.name, size);
    let sent = 0;
    if ("data" in e) { yield e.data; sent = e.data.length; }
    else for await (const c of readFile(e.file)) { yield c; sent += c.length; }
    if (sent !== size) throw new Error(`${e.name} changed while it was being added`);
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(BLOCK * 2);
}
