// Einschwing-Erkennung und Gültigkeitsprüfung eines Messpunkts.

const KEYS = ['vin', 'iin', 'pin', 'vout', 'iout', 'pout'];

/**
 * Stabil, wenn nach der Mindestwartezeit Pin und Pout über das ganze Zeitfenster
 * weniger als max(relTol · Mittelwert, absTolW) schwanken. Ergebnis = Mittelwert über das Fenster.
 */
export class SettleDetector {
  constructor(config) {
    this.config = config;
    this.reset(0);
  }

  reset(t0) {
    this.t0 = t0;
    this.samples = [];
    this.state = 'wait';
  }

  /** sample: { t, vin, iin, pin, vout, iout, pout } → 'wait' | 'settling' | 'stable' | 'timeout' */
  add(s) {
    const c = this.config;
    const age = s.t - this.t0;
    if (age >= c.minWaitMs) {
      this.samples.push(s);
      while (this.samples.length > 2 && s.t - this.samples[1].t >= c.windowMs) this.samples.shift();
    }
    if (age < c.minWaitMs) this.state = 'wait';
    else if (this._stable()) this.state = 'stable';
    else if (age >= c.timeoutMs) this.state = 'timeout';
    else this.state = 'settling';
    return this.state;
  }

  /** Größte relative Schwankung von Pin/Pout im Fenster (zur Anzeige). */
  get spread() {
    const w = this.samples;
    if (w.length < 2) return null;
    let worst = 0;
    for (const k of ['pin', 'pout']) {
      const vals = w.map((x) => x[k]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      worst = Math.max(worst, (Math.max(...vals) - Math.min(...vals)) / Math.max(Math.abs(mean), 1e-9));
    }
    return worst;
  }

  _stable() {
    const c = this.config, w = this.samples;
    if (w.length < 3 || w[w.length - 1].t - w[0].t < c.windowMs * 0.9) return false;
    for (const k of ['pin', 'pout']) {
      let mn = Infinity, mx = -Infinity, sum = 0;
      for (const x of w) { mn = Math.min(mn, x[k]); mx = Math.max(mx, x[k]); sum += x[k]; }
      const mean = sum / w.length;
      if (mx - mn > Math.max(c.relTol * Math.abs(mean), c.absTolW)) return false;
    }
    return true;
  }

  /** Mittelwerte über das Fenster. */
  result() {
    const w = this.samples.length ? this.samples : [];
    const avg = { n: w.length };
    for (const k of KEYS) avg[k] = w.length ? w.reduce((a, x) => a + x[k], 0) / w.length : NaN;
    return avg;
  }
}

/**
 * Prüft einen gemittelten Messpunkt. Liefert einen Text (ungültig) oder null.
 * ctx: { ioutSet, voutRef, voutTol, iinMax, srcStatus, sinkStatus }
 */
export function validatePoint(avg, ctx) {
  if (ctx.srcStatus?.fault) return `Quelle: ${ctx.srcStatus.fault}`;
  if (ctx.sinkStatus?.fault) return `Last: ${ctx.sinkStatus.fault}`;
  if (ctx.srcStatus?.cc) return `Quelle in Strombegrenzung (Iin ${avg.iin.toFixed(3)} A)`;
  if (avg.iin >= ctx.iinMax * 0.99) return `Eingangsstrom an der Grenze (${avg.iin.toFixed(3)} A)`;
  if (ctx.voutRef && avg.vout < ctx.voutRef * (1 - ctx.voutTol)) {
    return `Vout eingebrochen (${avg.vout.toFixed(3)} V < ${(ctx.voutRef * (1 - ctx.voutTol)).toFixed(3)} V)`;
  }
  if (ctx.ioutSet > 0 && avg.iout < ctx.ioutSet * 0.9 - 0.005) {
    return `Last erreicht den Strom nicht (${avg.iout.toFixed(3)} A statt ${ctx.ioutSet} A)`;
  }
  if (!(avg.pin > 0)) return 'keine Eingangsleistung gemessen';
  return null;
}
