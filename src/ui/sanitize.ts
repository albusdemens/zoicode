// ESC-introduced sequences: CSI (ESC [ ... final), OSC/DCS/PM/APC/SOS (terminated by BEL or ESC \), and two-byte escapes.
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)|[@-Z\\-_]|$)/g;
// C1 controls (8-bit CSI/OSC etc.) and C0 controls other than tab and newline.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

// Unicode format characters are invisible, and the bidi ones reorder text, so a command could look
// different from what runs ("Trojan Source"). They show as <U+XXXX>, except, in everyday text, the ones
// emoji and some scripts need: joiners, direction marks, soft hyphens and the tags of flag emoji.
const FORMAT = /[\p{Cf}\u115f\u1160\u3164\uffa0]/gu;
const EVERYDAY_FORMAT = new Set([0xad, 0x200c, 0x200d, 0x200e, 0x200f, 0x61c]);

function clean(s: string, strict: boolean): string {
  return String(s)
    .replace(ESCAPE_SEQUENCE, '')
    .replace(CONTROL, ch => {
      const code = ch.charCodeAt(0);
      return code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? '␡' : '�';
    })
    .replace(FORMAT, ch => {
      const cp = ch.codePointAt(0)!;
      if (!strict && (EVERYDAY_FORMAT.has(cp) || (cp >= 0xe0020 && cp <= 0xe007f))) return ch;
      return `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
    });
}

/**
 * Makes untrusted text (model-chosen commands, paths, tool output, text from the project or the API)
 * safe to print: removes terminal escape sequences, shows other control characters as visible Unicode
 * control pictures, and marks invisible or reordering characters, so a carriage return, a "conceal"
 * code or a bidi override can't hide what is really there.
 */
export function sanitize(s: string): string {
  return clean(s, false);
}

/** sanitize, also marking the joiners and direction marks it keeps: for what an approval prompt shows. */
export function sanitizeStrict(s: string): string {
  return clean(s, true);
}
