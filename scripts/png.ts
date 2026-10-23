/** Tiny dependency-free PNG writer for sprite previews. */
import zlib from 'node:zlib';

export type RGB = [number, number, number];

export const hex = (c: string): RGB => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)) as RGB;

export class Canvas {
  data: Buffer;
  constructor(public w: number, public h: number, bg: RGB) {
    this.data = Buffer.alloc(w * h * 3);
    this.rect(0, 0, w, h, bg);
  }
  rect(x0: number, y0: number, w: number, h: number, [r, g, b]: RGB) {
    for (let y = Math.max(0, y0); y < Math.min(this.h, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(this.w, x0 + w); x++) {
        const i = (y * this.w + x) * 3;
        this.data[i] = r;
        this.data[i + 1] = g;
        this.data[i + 2] = b;
      }
    }
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(cv: Canvas): Buffer {
  const stride = cv.w * 3;
  const raw = Buffer.alloc((stride + 1) * cv.h);
  for (let y = 0; y < cv.h; y++) cv.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cv.w, 0);
  ihdr.writeUInt32BE(cv.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

