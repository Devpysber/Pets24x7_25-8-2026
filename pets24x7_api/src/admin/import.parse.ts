// CSV / JSON parsing for the admin importer.
//
// Hand-rolled RFC4180 CSV reader rather than a dependency: the input is a
// pasted file from an admin, the grammar is small, and quoting rules ("" for a
// literal quote, newlines inside quotes) are the only tricky part.

export interface ParsedTable {
  columns: string[];
  rows: Record<string, string>[];
}

export function parseCsv(text: string): ParsedTable {
  const src = text.replace(/^﻿/, ''); // strip BOM Excel loves to add
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
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (!nonEmpty.length) return { columns: [], rows: [] };

  const columns = nonEmpty[0]!.map((h, i) => h.trim() || `column_${i + 1}`);
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

/**
 * Best-effort guess of which source column feeds a target field, so the admin
 * starts from a filled-in mapping instead of a blank form.
 */
export function suggestMapping(columns: string[], fields: { key: string; aliases: string[] }[]): Record<string, string> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const byNorm = new Map<string, string>();
  for (const c of columns) byNorm.set(norm(c), c);

  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  for (const f of fields) {
    for (const alias of [f.key, ...f.aliases]) {
      const hit = byNorm.get(norm(alias));
      if (hit && !used.has(hit)) { mapping[f.key] = hit; used.add(hit); break; }
    }
  }
  return mapping;
}
