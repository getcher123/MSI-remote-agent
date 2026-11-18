// Offsets are absolute UTF-16 code-unit positions, not indices into a rolling tail.
export class OutputBuffer {
  constructor(limit = 1_000_000) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid output buffer limit');
    this.limit = limit;
    this.text = '';
    this.total = 0;
  }
  append(text) {
    this.total += text.length;
    this.text = (this.text + text).slice(-this.limit);
    // Do not retain a lone low surrogate if a supplementary character was cut.
    if (/^[\uDC00-\uDFFF]/.test(this.text)) this.text = this.text.slice(1);
  }
  get base() { return this.total - this.text.length; }
  read(offset = 0, maxChars = 20000) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a nonnegative safe integer');
    if (!Number.isSafeInteger(maxChars) || maxChars < 0 || maxChars > 200000) throw new Error('max_chars must be 0..200000');
    const start = Math.min(Math.max(offset, this.base), this.total);
    const text = this.text.slice(start - this.base, start - this.base + maxChars);
    const next = start + text.length;
    const lost = Math.max(0, this.base - offset);
    const hasMore = next < this.total;
    return { text, start, next, total: this.total, base: this.base, lost, hasMore, truncated: lost > 0 || hasMore };
  }
}
