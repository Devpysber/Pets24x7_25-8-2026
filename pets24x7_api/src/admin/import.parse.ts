// CSV / JSON / XLSX parsing for the admin importer.
//
// Hand-rolled RFC4180 CSV reader rather than a dependency: the input is a
// pasted file from an admin, the grammar is small, and quoting rules ("" for a
// literal quote, newlines inside quotes) are the only tricky part.
//
// Excel workbooks (.xlsx) go through read-excel-file — maintained, and not the
// npm `xlsx` (SheetJS) package, whose registry copy carries unpatched
// prototype-pollution and ReDoS advisories. The panel sends the workbook as
// base64 (`encoding: 'base64'`) in the same `content` field a CSV uses.

import { inflateRawSync } from 'node:zlib';
import { zipSync, type Zippable } from 'fflate';
import { readSheet } from 'read-excel-file/node';

export interface ParsedTable {
  columns: string[];
  rows: Record<string, string>[];
}

/**
 * Excel in many locales saves "CSV" with semicolons, and a copy-paste from a
 * sheet gives tabs. Pick whichever separator the header line (outside quotes)
 * uses most; comma wins ties. Reading such a file as comma-separated produced
 * one giant column and no mappable fields.
 */
function detectDelimiter(src: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && c === '\n') break;
    else if (!inQuotes && c in counts) counts[c] = (counts[c] ?? 0) + 1;
  }
  let best = ',';
  for (const d of [';', '\t']) if ((counts[d] ?? 0) > (counts[best] ?? 0)) best = d;
  return best;
}

export function parseCsv(text: string): ParsedTable {
  const src = text.replace(/^﻿/, ''); // strip BOM Excel loves to add
  const delim = detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === delim) { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (!nonEmpty.length) return { columns: [], rows: [] };

  // Blank headers get a placeholder and repeated ones a suffix — two columns
  // both called "Phone" used to collapse into one, losing the first's data.
  const seen = new Map<string, number>();
  const columns = nonEmpty[0]!.map((h, i) => {
    const base = h.trim() || `column_${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
  const out: Record<string, string>[] = [];
  for (const r of nonEmpty.slice(1)) {
    const obj: Record<string, string> = {};
    columns.forEach((col, i) => { obj[col] = (r[i] ?? '').trim(); });
    out.push(obj);
  }
  return { columns, rows: out };
}

export function parseJson(text: string): ParsedTable {
  const data = JSON.parse(text);
  const arr: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as any)?.rows)
      ? (data as any).rows
      : Array.isArray((data as any)?.data)
        ? (data as any).data
        : [];
  if (!arr.length) return { columns: [], rows: [] };

  // Union of keys across the sample — JSON exports often omit empty fields.
  const columns: string[] = [];
  for (const item of arr.slice(0, 200)) {
    if (item && typeof item === 'object') {
      for (const k of Object.keys(item as object)) if (!columns.includes(k)) columns.push(k);
    }
  }
  const rows = arr
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((item) => {
      const obj: Record<string, string> = {};
      for (const col of columns) {
        const v = (item as any)[col];
        obj[col] = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v).trim();
      }
      return obj;
    });
  return { columns, rows };
}

export function parseTable(text: string, fileName?: string): ParsedTable {
  const looksJson = /\.json$/i.test(fileName ?? '') || /^\s*[[{]/.test(text);
  return looksJson ? parseJson(text) : parseCsv(text);
}

/** Workbook limits: a zip can expand far past its upload size. */
const XLSX_MAX_UNZIPPED = 60 * 1024 * 1024;
const XLSX_MAX_ENTRIES = 2000;

/** True for an Excel file name, or content that is base64 of a zip ("UEsDB" is a base64 zip header). */
export function isXlsxUpload(content: string, fileName?: string, encoding?: string): boolean {
  if (/\.xls[xm]?$/i.test(fileName ?? '')) return true;
  if (encoding === 'base64') return true;
  return /^(?:data:[^,]*;base64,)?UEsDB/.test(content.slice(0, 80));
}

function base64Bytes(content: string): Buffer {
  const b64 = content.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error('The workbook was not sent as base64.');
  return Buffer.from(b64, 'base64');
}

const DAMAGED = 'The workbook is damaged or not a real .xlsx file. Open it in Excel and save it again.';
const TOO_LARGE = 'The workbook is too large once unpacked. Split it into smaller files.';

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  size: number;
  headerOffset: number;
}

/** Fields of a ZIP64 extra block (id 1): only those whose 32-bit field is 0xFFFFFFFF, in this order. */
function zip64Extra(buf: Buffer, start: number, end: number, e: ZipEntry): void {
  for (let p = start; p + 4 <= end; ) {
    const id = buf.readUInt16LE(p);
    const len = buf.readUInt16LE(p + 2);
    const body = p + 4;
    if (body + len > end) throw new Error(DAMAGED);
    if (id === 0x0001) {
      let q = body;
      const next = (): number => {
        if (q + 8 > body + len) throw new Error(DAMAGED);
        const v = buf.readBigUInt64LE(q);
        q += 8;
        if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(TOO_LARGE);
        return Number(v);
      };
      if (e.size === 0xffffffff) e.size = next();
      if (e.compressedSize === 0xffffffff) e.compressedSize = next();
      if (e.headerOffset === 0xffffffff) e.headerOffset = next();
      return;
    }
    p = body + len;
  }
}

/**
 * The archive's central directory. Only this is trusted for names and sizes:
 * local headers are used for nothing but the offset of each entry's data.
 */
function zipDirectory(buf: Buffer): ZipEntry[] {
  // End of central directory: 22 bytes plus a comment of up to 64 KB.
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(DAMAGED);
  let count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z = Number(buf.readBigUInt64LE(eocd - 12));
    if (z + 56 > buf.length || buf.readUInt32LE(z) !== 0x06064b50) throw new Error(DAMAGED);
    count = Number(buf.readBigUInt64LE(z + 32));
    offset = Number(buf.readBigUInt64LE(z + 48));
  }
  if (count > XLSX_MAX_ENTRIES) throw new Error(TOO_LARGE);

  const out: ZipEntry[] = [];
  let p = offset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error(DAMAGED);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const nameEnd = p + 46 + nameLen;
    if (nameEnd + extraLen + commentLen > buf.length) throw new Error(DAMAGED);
    const flags = buf.readUInt16LE(p + 8);
    const e: ZipEntry = {
      // Bit 11: UTF-8 name. Workbook part names are ASCII either way.
      name: buf.toString(flags & 0x0800 ? 'utf8' : 'latin1', p + 46, nameEnd),
      flags,
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      headerOffset: buf.readUInt32LE(p + 42),
    };
    zip64Extra(buf, nameEnd, nameEnd + extraLen, e);
    out.push(e);
    p = nameEnd + extraLen + commentLen;
  }
  return out;
}

/** One entry's bytes, inflated to exactly the size the directory declares — never more. */
function zipEntryData(buf: Buffer, e: ZipEntry): Buffer {
  if (e.flags & 0x0001) throw new Error('The workbook is password-protected. Remove the password and upload it again.');
  const h = e.headerOffset;
  if (h + 30 > buf.length || buf.readUInt32LE(h) !== 0x04034b50) throw new Error(DAMAGED);
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  if (start + e.compressedSize > buf.length) throw new Error(DAMAGED);
  const raw = buf.subarray(start, start + e.compressedSize);
  let data: Buffer;
  if (e.method === 0) {
    data = raw;
  } else if (e.method === 8) {
    try {
      // zlib stops and throws as soon as the output passes the limit, so a
      // directory that under-declares a size cannot make this allocate more.
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) });
    } catch (err: any) {
      throw new Error(err?.code === 'ERR_BUFFER_TOO_LARGE' ? TOO_LARGE : DAMAGED);
    }
  } else {
    throw new Error(DAMAGED);
  }
  if (data.length !== e.size) throw new Error(DAMAGED);
  return data;
}

/**
 * The workbook's XML parts, unpacked under the size limit and packed again,
 * uncompressed, into a clean archive for read-excel-file.
 *
 * read-excel-file unzips by streaming the LOCAL file headers: it allocates
 * whatever size a local header claims, collects data without any limit when a
 * header defers its size to a data descriptor, and inflates local entries the
 * central directory does not even list. A size check against the central
 * directory therefore guarded nothing; a workbook that declared small sizes
 * there could still inflate its local entries to gigabytes and take the API
 * down. Handing it an archive built here from checked data closes that: every
 * size it can see is one that was actually inflated.
 */
function sanitizeXlsx(bytes: Buffer): Buffer {
  try {
    return repackXlsx(bytes);
  } catch (err: any) {
    // A truncated archive walks a read past the end of the buffer.
    if (err?.code === 'ERR_OUT_OF_RANGE') throw new Error(DAMAGED);
    throw err;
  }
}

function repackXlsx(bytes: Buffer): Buffer {
  const entries = zipDirectory(bytes);
  // The parts read-excel-file reads (its own filter); images, printer
  // settings and the like are never inflated.
  const wanted = entries.filter((e) => e.name.endsWith('.xml') || e.name.endsWith('.xml.rels'));
  let total = 0;
  for (const e of wanted) {
    total += e.size;
    if (total > XLSX_MAX_UNZIPPED) throw new Error(TOO_LARGE);
  }
  const files: Zippable = Object.create(null);
  for (const e of wanted) files[e.name] = [zipEntryData(bytes, e), { level: 0 }];
  const out = zipSync(files);
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * First worksheet of an .xlsx workbook as a table: row 1 is the header, as in
 * a CSV. Cell numbers are kept exactly as stored (a phone stays 9876543210,
 * not 9.88E+09); dates become YYYY-MM-DD.
 */
export async function parseXlsx(content: string): Promise<ParsedTable> {
  const bytes = base64Bytes(content);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xd0cf11e0) {
      throw new Error('This is an old Excel .xls file. Save it as .xlsx (or CSV) and upload that.');
    }
    throw new Error('This is not an .xlsx workbook.');
  }
  // Zip-bomb guard: the parser only ever sees data inflated here under the
  // limit (sanitizeXlsx).
  const data = await readSheet(sanitizeXlsx(bytes), { parseNumber: (v: string) => v, trim: true });
  const cell = (v: unknown): string => {
    if (v == null) return '';
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
    return String(v).trim();
  };
  const rows = data.map((r) => r.map(cell)).filter((r) => r.some((v) => v !== ''));
  if (!rows.length) return { columns: [], rows: [] };

  const seen = new Map<string, number>();
  const columns = rows[0]!.map((h, i) => {
    const base = h || `column_${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
  const out = rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    columns.forEach((col, i) => { obj[col] = r[i] ?? ''; });
    return obj;
  });
  return { columns, rows: out };
}

/** Any upload the importer accepts: CSV/TSV/semicolon text, JSON, or an .xlsx workbook. */
export async function parseUpload(content: string, fileName?: string, encoding?: string): Promise<ParsedTable> {
  if (isXlsxUpload(content, fileName, encoding)) return parseXlsx(content);
  return parseTable(content, fileName);
}

/**
 * Best-effort guess of which source column feeds a target field, so the admin
 * starts from a filled-in mapping instead of a blank form.
 */
export function suggestMapping(columns: string[], fields: { key: string; label?: string; aliases: string[] }[]): Record<string, string> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const byNorm = new Map<string, string>();
  for (const c of columns) byNorm.set(norm(c), c);

  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  for (const f of fields) {
    // The label too: the template's own headers ("Services Offered") must map.
    for (const alias of [f.key, ...(f.label ? [f.label] : []), ...f.aliases]) {
      const hit = byNorm.get(norm(alias));
      if (hit && !used.has(hit)) { mapping[f.key] = hit; used.add(hit); break; }
    }
  }
  return mapping;
}
