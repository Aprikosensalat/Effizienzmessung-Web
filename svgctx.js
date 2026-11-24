// Kleine SVG-Zeichenfläche mit der Teilmenge der Canvas-2D-API, die effplot.js nutzt.
// So erzeugt derselbe Zeichencode Bildschirm, PNG und SVG.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r = (x) => Math.round(x * 100) / 100;

export class SvgContext {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.out = [];
    this.defs = [];
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.lineJoin = 'miter';
    this.globalAlpha = 1;
    this.font = '10px sans-serif';
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    this._dash = [];
    this._m = [1, 0, 0, 1, 0, 0]; // Transformationsmatrix
    this._clip = null;
    this._stack = [];
    this._path = '';
    this._clipN = 0;
    this._measure = document.createElement('canvas').getContext('2d');
  }

  // ---- Zustand ----
  save() {
    this._stack.push({
      fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, lineJoin: this.lineJoin,
      globalAlpha: this.globalAlpha, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline,
      dash: this._dash, m: [...this._m], clip: this._clip,
    });
  }

  restore() {
    const s = this._stack.pop();
    if (!s) return;
    Object.assign(this, {
      fillStyle: s.fillStyle, strokeStyle: s.strokeStyle, lineWidth: s.lineWidth, lineJoin: s.lineJoin,
      globalAlpha: s.globalAlpha, font: s.font, textAlign: s.textAlign, textBaseline: s.textBaseline,
    });
    this._dash = s.dash;
    this._m = s.m;
    this._clip = s.clip;
  }

  setLineDash(d) { this._dash = [...d]; }
  translate(x, y) { this._mul([1, 0, 0, 1, x, y]); }
  rotate(a) { const c = Math.cos(a), s = Math.sin(a); this._mul([c, s, -s, c, 0, 0]); }
  scale(x, y) { this._mul([x, 0, 0, y, 0, 0]); }
  setTransform(a, b, c, d, e, f) { this._m = [a, b, c, d, e, f]; }

  _mul([a2, b2, c2, d2, e2, f2]) {
    const [a, b, c, d, e, f] = this._m;
    this._m = [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f];
  }

  // ---- Pfade ----
  beginPath() { this._path = ''; }
  moveTo(x, y) { if (Number.isFinite(x) && Number.isFinite(y)) this._path += `M${r(x)} ${r(y)}`; }
  lineTo(x, y) { if (Number.isFinite(x) && Number.isFinite(y)) this._path += (this._path ? 'L' : 'M') + `${r(x)} ${r(y)}`; }
  closePath() { this._path += 'Z'; }
  rect(x, y, w, h) { this._path += `M${r(x)} ${r(y)}h${r(w)}v${r(h)}h${r(-w)}Z`; }

  arc(x, y, rad, a0, a1) {
    // als Polygonzug annähern (genügt für Messpunkte)
    const n = Math.max(8, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 12)));
    for (let k = 0; k <= n; k++) {
      const a = a0 + ((a1 - a0) * k) / n;
      const px = x + rad * Math.cos(a), py = y + rad * Math.sin(a);
      this._path += (k === 0 && !this._path ? 'M' : 'L') + `${r(px)} ${r(py)}`;
    }
  }

  clip() {
    const id = `c${++this._clipN}`;
    this.defs.push(`<clipPath id="${id}"><path d="${this._path}"${this._tf()}/></clipPath>`);
    this._clip = id;
  }

  // ---- Zeichnen ----
  _tf() {
    const [a, b, c, d, e, f] = this._m;
    return a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0 ? '' : ` transform="matrix(${[a, b, c, d, e, f].map(r).join(' ')})"`;
  }

  _common() {
    let s = this._tf();
    if (this.globalAlpha !== 1) s += ` opacity="${r(this.globalAlpha)}"`;
    if (this._clip) s += ` clip-path="url(#${this._clip})"`;
    return s;
  }

  stroke() {
    if (!this._path) return;
    const dash = this._dash.length ? ` stroke-dasharray="${this._dash.join(' ')}"` : '';
    this.out.push(`<path d="${this._path}" fill="none" stroke="${esc(this.strokeStyle)}" stroke-width="${r(this.lineWidth)}" stroke-linejoin="${this.lineJoin}"${dash}${this._common()}/>`);
  }

  fill() {
    if (!this._path) return;
    this.out.push(`<path d="${this._path}" fill="${esc(this.fillStyle)}"${this._common()}/>`);
  }

  fillRect(x, y, w, h) {
    this.out.push(`<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="${esc(this.fillStyle)}"${this._common()}/>`);
  }

  strokeRect(x, y, w, h) {
    this.out.push(`<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="none" stroke="${esc(this.strokeStyle)}" stroke-width="${r(this.lineWidth)}"${this._common()}/>`);
  }

  measureText(t) {
    this._measure.font = this.font;
    return this._measure.measureText(t);
  }

  fillText(text, x, y) {
    const anchor = { left: 'start', start: 'start', center: 'middle', right: 'end', end: 'end' }[this.textAlign] ?? 'start';
    const base = { top: 'hanging', middle: 'middle', bottom: 'text-after-edge', alphabetic: 'alphabetic' }[this.textBaseline] ?? 'alphabetic';
    const m = this.font.match(/^(?:(\d{3}|bold)\s+)?(\d+(?:\.\d+)?)px\s+(.*)$/);
    const weight = m?.[1] ? ` font-weight="${m[1]}"` : '';
    const size = m ? m[2] : 10;
    const family = m ? m[3] : 'sans-serif';
    this.out.push(`<text x="${r(x)}" y="${r(y)}" fill="${esc(this.fillStyle)}" font-size="${size}" font-family="${esc(family)}"${weight} text-anchor="${anchor}" dominant-baseline="${base}"${this._common()}>${esc(text)}</text>`);
  }

  toString() {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">\n` +
      (this.defs.length ? `<defs>${this.defs.join('')}</defs>\n` : '') + this.out.join('\n') + '\n</svg>\n';
  }
}
