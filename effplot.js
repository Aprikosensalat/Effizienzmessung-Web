// Wirkungsgrad über Ausgangsstrom, eine Kurve je Vout/Vin-Kombination. PNG-Export mit Legende.

import { niceStep, decimals, prepareCanvas } from './plot.js';

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const PALETTE = ['--c-volt', '--c-curr', '--c-pow', '--c-ext1', '--c-ext2', '--c-ext3', '--c-ext4', '--cur-a', '--cur-b'];
const DASHES = [[], [7, 4], [2, 3], [9, 3, 2, 3]];
const fmt = (x, d) => x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });

export class EfficiencyPlot {
  constructor(canvas, legendEl, hoverEl) {
    this.canvas = canvas;
    this.legendEl = legendEl;
    this.hoverEl = hoverEl;
    this.curves = [];
    this.hidden = new Set();
    this.logX = false;
    this.title = '';
    this.hoverX = this.hoverY = null;
    this._raf = 0;
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.hoverY = e.clientY - r.top;
      this.requestDraw();
    });
    canvas.addEventListener('mouseleave', () => { this.hoverX = null; this.requestDraw(); });
    new ResizeObserver(() => this.requestDraw()).observe(canvas);
  }

  /** results: ResultSet; Farben werden je Vin, Strichart je Vout vergeben. */
  setResults(results) {
    this.title = results ? [results.meta.dut, results.meta.name].filter(Boolean).join(' – ') : '';
    const curves = results ? results.curves() : [];
    const vins = [...new Set(curves.map((c) => c.vin))];
    const vouts = [...new Set(curves.map((c) => c.voutNom))];
    this.curves = curves.map((c) => ({
      ...c,
      color: PALETTE[vins.indexOf(c.vin) % PALETTE.length],
      dash: DASHES[vouts.indexOf(c.voutNom) % DASHES.length],
      pts: c.points.filter((p) => (p.flag === 'ok' || p.flag === 'timeout') && Number.isFinite(p.eta) && p.iout > 0),
    }));
    this._legend();
    this.requestDraw();
  }

  _legend() {
    this.legendEl.innerHTML = '';
    for (const c of this.curves) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'eff-leg' + (this.hidden.has(c.key) ? ' off' : '');
      const sw = document.createElement('span');
      sw.className = 'eff-sw';
      sw.style.borderTopColor = `var(${c.color})`;
      sw.style.borderTopStyle = c.dash.length ? 'dashed' : 'solid';
      b.append(sw, c.label);
      b.title = 'Kurve ein-/ausblenden';
      b.addEventListener('click', () => {
        this.hidden.has(c.key) ? this.hidden.delete(c.key) : this.hidden.add(c.key);
        this._legend();
        this.requestDraw();
      });
      this.legendEl.append(b);
    }
  }

  requestDraw() {
    if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
  }

  draw() {
    const { ctx, w } = prepareCanvas(this.canvas, 380);
    this._render(ctx, w, 380, { hover: true });
  }

  /** Zeichnet in einen beliebigen Kontext (Bildschirm oder PNG). */
  _render(ctx, w, h, { hover = false, legend = false, title = false, bg = null } = {}) {
    const text = cssVar('--muted'), grid = cssVar('--border'), fg = cssVar('--fg');
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
    const vis = this.curves.filter((c) => !this.hidden.has(c.key) && c.pts.length);
    const legendRows = legend ? Math.ceil(vis.length / Math.max(1, Math.floor((w - 80) / 220))) : 0;
    const left = 62, right = 18, top = title ? 40 : 14, bottom = h - 44 - legendRows * 20;
    const pw = w - left - right, ph = bottom - top;
    ctx.font = '12px system-ui, sans-serif';
    if (title && this.title) {
      ctx.fillStyle = fg; ctx.font = '600 15px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`Wirkungsgrad ${this.title}`, left, 12);
      ctx.font = '12px system-ui, sans-serif';
    }
    if (!vis.length || pw <= 0) {
      ctx.fillStyle = text; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('Noch keine gültigen Messpunkte', left, top + 10);
      if (this.hoverEl) this.hoverEl.textContent = ' ';
      return;
    }
    const all = vis.flatMap((c) => c.pts);
    let xMin = Math.min(...all.map((p) => p.iout)), xMax = Math.max(...all.map((p) => p.iout));
    let yMin = Math.min(...all.map((p) => p.eta * 100)), yMax = Math.max(...all.map((p) => p.eta * 100));
    const logX = this.logX && xMin > 0;
    if (logX) {
      xMin = 10 ** Math.floor(Math.log10(xMin));
      xMax = 10 ** Math.ceil(Math.log10(xMax));
    } else {
      xMin = 0;
      xMax = xMax * 1.05 || 1;
    }
    const ySpan = Math.max(yMax - yMin, 2);
    yMin = Math.max(0, yMin - ySpan * 0.1);
    yMax = Math.min(110, yMax + ySpan * 0.1);
    const xOf = (x) => left + (logX ? (Math.log10(x) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin)) : (x - xMin) / (xMax - xMin)) * pw;
    const yOf = (y) => bottom - ((y - yMin) / (yMax - yMin)) * ph;

    // Gitter
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.fillStyle = text;
    const ys = niceStep(yMax - yMin, 6), yd = decimals(ys);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let y = Math.ceil(yMin / ys) * ys; y <= yMax + 1e-9; y += ys) {
      const py = Math.round(yOf(y)) + 0.5;
      ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(left + pw, py); ctx.stroke();
      ctx.fillText(y.toFixed(yd), left - 6, py);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const xTicks = [];
    if (logX) {
      for (let e = Math.log10(xMin); e <= Math.log10(xMax) + 1e-9; e++) {
        for (const m of [1, 2, 5]) { const x = m * 10 ** e; if (x >= xMin && x <= xMax) xTicks.push([x, m === 1]); }
      }
    } else {
      const xs = niceStep(xMax - xMin, 8);
      for (let x = 0; x <= xMax + 1e-9; x += xs) xTicks.push([x, true]);
    }
    for (const [x, major] of xTicks) {
      const px = Math.round(xOf(x)) + 0.5;
      ctx.globalAlpha = major ? 1 : 0.5;
      ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(Number(x.toPrecision(3)).toLocaleString('de-DE'), px, bottom + 5);
    }
    ctx.strokeRect(left + 0.5, top + 0.5, pw - 1, ph - 1);
    ctx.fillText('Ausgangsstrom [A]', left + pw / 2, bottom + 22);
    ctx.save(); ctx.translate(14, top + ph / 2); ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'middle'; ctx.fillText('Wirkungsgrad [%]', 0, 0); ctx.restore();

    // Kurven
    let near = null, best = 14 * 14;
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, pw, ph); ctx.clip();
    for (const c of vis) {
      const col = cssVar(c.color);
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2; ctx.setLineDash(c.dash);
      ctx.beginPath();
      c.pts.forEach((p, k) => { const x = xOf(p.iout), y = yOf(p.eta * 100); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke(); ctx.setLineDash([]);
      for (const p of c.pts) {
        const x = xOf(p.iout), y = yOf(p.eta * 100);
        ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
        if (p.flag === 'ok' && !p.lowAccuracy) ctx.fill(); else { ctx.lineWidth = 1.5; ctx.stroke(); }
        if (hover && this.hoverX !== null) {
          const d = (x - this.hoverX) ** 2 + (y - this.hoverY) ** 2;
          if (d < best) { best = d; near = { p, c, x, y }; }
        }
      }
    }
    ctx.restore();

    if (near) {
      ctx.strokeStyle = fg; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(near.x, near.y, 6, 0, 2 * Math.PI); ctx.stroke();
    }
    if (this.hoverEl && hover) {
      const p = near?.p;
      this.hoverEl.textContent = p
        ? `${near.c.label} · Iout ${fmt(p.iout, 3)} A · η ${fmt(p.eta * 100, 2)} % · Pin ${fmt(p.pin, 3)} W · Pout ${fmt(p.pout, 3)} W · Verlust ${fmt(p.ploss, 3)} W · Vout ${fmt(p.vout, 3)} V${p.note ? ' · ' + p.note : ''}`
        : 'Zeiger auf einen Messpunkt bewegen · offene Punkte: nicht eingeschwungen oder ungenau';
    }

    if (legend) {
      const colW = 220, perRow = Math.max(1, Math.floor((w - 80) / colW));
      vis.forEach((c, k) => {
        const x = left + (k % perRow) * colW, y = bottom + 40 + Math.floor(k / perRow) * 20;
        ctx.strokeStyle = cssVar(c.color); ctx.lineWidth = 2.5; ctx.setLineDash(c.dash);
        ctx.beginPath(); ctx.moveTo(x, y + 6); ctx.lineTo(x + 26, y + 6); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(c.label, x + 32, y + 6);
      });
    }
  }

  /** PNG mit Titel und Legende. */
  toPng(width = 1400, height = 850) {
    const c = document.createElement('canvas');
    const scale = 1;
    c.width = width * scale; c.height = height * scale;
    const ctx = c.getContext('2d');
    ctx.scale(scale, scale);
    this._render(ctx, width, height, { legend: true, title: true, bg: cssVar('--card') });
    return new Promise((r) => c.toBlob(r, 'image/png'));
  }
}
