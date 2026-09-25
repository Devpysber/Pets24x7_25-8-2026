// Photos an admin attaches to a directory listing (usually an unclaimed one).
//
// Same storage rule as a vendor's own photos (Vendor.imageUrl/galleryImages in
// vendors/dashboard.routes.ts): no file store — each photo is either a hosted
// http(s) URL or a small, client-resized base64 data URL, kept as a JSON array
// in listings.photos and served inline by GET /api/listings/:id. On top of the
// vendor rule, a data URL's bytes must really be the image type it claims, and
// JPEG/PNG/WebP metadata (EXIF: camera, GPS position, timestamps) is removed
// before it is stored.

import { BadRequestError } from '../shared/errors.js';

/** Most photos one listing holds: a cover plus five, like a vendor's storefront + gallery. */
export const MAX_LISTING_PHOTOS = 6;
/** Per photo, as a string — the same ceiling the vendor photo fields use. */
export const MAX_PHOTO_CHARS = 600_000;

/** The vendor rule (vendors/dashboard.routes.ts IMAGE_SRC), unchanged. */
export const IMAGE_SRC =
  /^(?:https?:\/\/[^\s"'<>`]+|data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+)$/;

const DATA_URL = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/;

type Kind = 'png' | 'jpeg' | 'webp' | 'gif';

function sniff(buf: Buffer): Kind | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'gif';
  return null;
}

/**
 * Drops APP1 (EXIF / XMP) and APP13 (IPTC) segments from a JPEG. Everything
 * from the start-of-scan marker on is copied as is. Returns the input when the
 * structure is not what a JPEG should be, rather than guessing.
 */
export function stripJpegMetadata(buf: Buffer): Buffer {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return buf;
    const marker = buf[i + 1]!;
    // Start of scan (or end of image): the rest is image data.
    if (marker === 0xda || marker === 0xd9) {
      parts.push(buf.subarray(i));
      return Buffer.concat(parts);
    }
    // Standalone markers carry no length.
    // A 0xFF fill byte before a marker is padding: skip it.
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return buf;
    const drop = marker === 0xe1 || marker === 0xed;
    if (!drop) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return buf;
}

/** Drops PNG eXIf and text chunks (tEXt/zTXt/iTXt), which can carry the same data. */
export function stripPngMetadata(buf: Buffer): Buffer {
  if (buf.length < 8) return buf;
  const parts: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) return buf;
    if (!['eXIf', 'tEXt', 'zTXt', 'iTXt'].includes(type)) parts.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(parts);
  }
  return buf;
}

/**
 * Drops the EXIF and XMP chunks of a WebP and clears their flags in the VP8X
 * header. A simple (VP8/VP8L only) WebP has nowhere to keep metadata and comes
 * back as is. Returns the input when the container is not what a WebP should
 * be, rather than guessing.
 */
export function stripWebpMetadata(buf: Buffer): Buffer {
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return buf;
  const end = 8 + buf.readUInt32LE(4);
  if (end > buf.length) return buf;
  const parts: Buffer[] = [];
  let dropped = false;
  let i = 12;
  while (i + 8 <= end) {
    const type = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (i + 8 + size > end) return buf;
    // Chunks are padded to an even length; some encoders leave out the last pad.
    const next = Math.min(end, i + 8 + size + (size & 1));
    if (type === 'EXIF' || type === 'XMP ') dropped = true;
    else if (type === 'VP8X' && size >= 10) {
      const chunk = Buffer.from(buf.subarray(i, next)); // a copy: the input is not modified
      chunk[8] = chunk[8]! & ~(0x08 | 0x04); // EXIF and XMP present
      parts.push(chunk);
    } else parts.push(buf.subarray(i, next));
    i = next;
  }
  if (i !== end || !dropped) return buf;
  const body = Buffer.concat(parts);
  const head = Buffer.from('RIFF\0\0\0\0WEBP', 'ascii');
  head.writeUInt32LE(4 + body.length, 4);
  return Buffer.concat([head, body]);
}

/**
 * Validates one photo and returns the form to store. Throws a 400 naming the
 * problem, so the panel can show it next to the file.
 */
export function cleanPhoto(src: unknown): string {
  if (typeof src !== 'string' || !src.trim()) throw new BadRequestError('A photo must be an image URL or an image data URL.');
  const v = src.trim();
  if (v.length > MAX_PHOTO_CHARS) {
    throw new BadRequestError(`Photo is too large (${Math.round(v.length / 1024)} KB encoded; limit ${Math.round(MAX_PHOTO_CHARS / 1024)} KB). Resize it and try again.`);
  }
  if (!IMAGE_SRC.test(v)) throw new BadRequestError('A photo must be an https:// image URL or a PNG, JPEG, WebP or GIF data URL.');
  const m = DATA_URL.exec(v);
  if (!m) return v; // hosted URL
  const declared: Kind = m[1] === 'jpg' || m[1] === 'jpeg' ? 'jpeg' : (m[1] as Kind);
  const bytes = Buffer.from(m[2]!.replace(/\s+/g, ''), 'base64');
  const actual = sniff(bytes);
  if (!actual) throw new BadRequestError('That file is not a PNG, JPEG, WebP or GIF image.');
  if (actual !== declared) throw new BadRequestError(`The file says it is ${declared.toUpperCase()} but its contents are ${actual.toUpperCase()}.`);
  // GIF has no standard place for camera or GPS data and is stored as is.
  const cleaned =
    actual === 'jpeg' ? stripJpegMetadata(bytes)
      : actual === 'png' ? stripPngMetadata(bytes)
        : actual === 'webp' ? stripWebpMetadata(bytes)
          : bytes;
  return `data:image/${actual};base64,${cleaned.toString('base64')}`;
}

/** listings.photos -> string[]; a malformed value reads as no photos. */
export function parsePhotos(raw: unknown): string[] {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && IMAGE_SRC.test(x)).slice(0, MAX_LISTING_PHOTOS) : [];
}
