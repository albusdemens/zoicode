// ESC-introduced sequences: CSI (ESC [ ... final), OSC/DCS/PM/APC/SOS (terminated by BEL or ESC \), and two-byte escapes.
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)|[@-Z\\-_]|$)/g;
// C1 controls (8-bit CSI/OSC etc.) and C0 controls other than tab and newline.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Makes untrusted text (model-chosen commands, paths, tool output) safe to print: removes terminal
 * escape sequences and shows other control characters as visible Unicode control pictures, so a
 * carriage return or "conceal" code can't hide what is really about to run.
 */
export function sanitize(s: string): string {
  return String(s)
    .replace(ESCAPE_SEQUENCE, '')
    .replace(CONTROL, ch => {
      const code = ch.charCodeAt(0);
      return code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? '␡' : '�';
    });
}
