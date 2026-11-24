// Ablaufsteuerung einer Effizienzmessung: Vout (Aufforderung) → Vin → Iout (aufsteigend).
// Abschalten immer in der Reihenfolge Last aus, dann Quelle aus.

import { SettleDetector, validatePoint } from './settle.js';
import { ResultSet } from './results.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const de = (x) => String(x).replace('.', ',');

class AbortRun extends Error {}

export class SweepRunner {
  /**
   * @param {{ source, sink, recorder,
   *   onSample?: (s) => void, onProgress?: (p) => void, onPoint?: (pt, results) => void,
   *   onPrompt?: (req) => Promise<void>, onEvent?: (text) => void }} o
   *   onPrompt muss auflösen, wenn der Nutzer die Ausgangsspannung bestätigt hat.
   */
  constructor(o) {
    Object.assign(this, { onSample() {}, onProgress() {}, onPoint() {}, onEvent() {} }, o);
    this.active = false;
    this.abortReason = null;
    this._promptReject = null;
  }

  abort(reason = 'abgebrochen') {
    if (!this.active || this.abortReason) return;
    this.abortReason = reason;
    this._promptReject?.(new AbortRun(reason));
  }

  _check() {
    if (this.abortReason) throw new AbortRun(this.abortReason);
  }

  _event(text) {
    this.recorder?.event(text);
    this.onEvent(text);
  }

  /** Ein Abtastwert: beide Geräte gleichzeitig abfragen (getrennte Ports). */
  async sample(ctx = {}) {
    // höchstens alle sampleMs einen Abtastwert (schnelle Geräte/Simulator erzeugen sonst unnötig viele Daten)
    const wait = (this._lastSample ?? 0) + (this.sampleMs ?? 250) - Date.now();
    if (wait > 0) await sleep(wait);
    this._lastSample = Date.now();
    const [src, snk] = await Promise.all([this.source.measure(), this.sink.measure()]);
    const s = {
      t: Date.now(), vin: src.v, iin: src.i, pin: src.v * src.i,
      vout: snk.v, iout: snk.i, pout: snk.v * snk.i,
    };
    s.eta = s.pin > 1e-4 ? (s.pout / s.pin) * 100 : NaN;
    this.recorder?.add(s.t, s.vout, s.iout, s.pout, {
      vin_V: s.vin, iin_A: s.iin, pin_W: s.pin, eta_pct: s.eta,
      vout_nenn_V: ctx.voutNom ?? NaN, vin_soll_V: ctx.vin ?? NaN, iout_soll_A: ctx.iout ?? NaN,
    });
    this.onSample(s);
    return s;
  }

  /** Abtasten für eine feste Zeit (z. B. nach dem Einstellen von Vin). */
  async _sampleFor(ms, ctx) {
    const end = Date.now() + ms;
    do {
      this._check();
      await this.sample(ctx);
    } while (Date.now() < end);
  }

  /**
   * Führt den Plan aus.
   * @returns {Promise<{ results: ResultSet, reason: string, completed: boolean }>}
   */
  async run(plan, meta = {}) {
    const { source: src, sink } = this;
    this.active = true;
    this.abortReason = null;
    this.plan = plan;
    const results = new ResultSet({ ...meta, params: plan.toParams() });
    this.results = results;
    const total = plan.pointCount();
    let done = 0, completed = false, reason = 'fertig';
    const progress = (extra) => this.onProgress({ done, total, ...extra });

    try {
      // Vorbereiten
      progress({ phase: 'Vorbereiten' });
      this.recorder?.setPhase('Vorbereiten');
      await sink.setInput(false);
      await sink.setCC();
      await sink.setCurrent(0);
      await sink.prepare(Math.max(...plan.iouts, plan.baseLoad));
      await src.setOutput(false);
      await src.setCurrentLimit(plan.iinMax);
      await src.setVoltage(plan.vins[0]);
      this._check();

      const vouts = plan.vouts.length ? plan.vouts : [null];
      for (const voutNom of vouts) {
        this._check();
        await sink.setInput(false);
        await src.setVoltage(plan.vins[0]);
        await src.setOutput(true);

        if (voutNom !== null) {
          // Nutzer stellt die Ausgangsspannung am Wandler ein
          if (plan.baseLoad > 0) { await sink.setCurrent(plan.baseLoad); await sink.setInput(true); }
          this.recorder?.setPhase(`Aufforderung: Vout auf ${de(voutNom)} V einstellen`);
          progress({ phase: 'Aufforderung', voutNom, vin: plan.vins[0] });
          await this._prompt({ voutNom, vin: plan.vins[0] });
          this._event(`Nutzer: Vout ${de(voutNom)} V bestätigt`);
          await sink.setInput(false);
        }

        for (const vin of plan.vins) {
          await this._curve(plan, voutNom, vin, results, (n) => { done += n; }, progress);
        }
      }
      completed = true;
    } catch (e) {
      reason = e instanceof AbortRun ? e.message : `Fehler: ${e.message}`;
      this._event(reason);
    } finally {
      await this.shutdown();
      this.active = false;
    }
    progress({ phase: completed ? 'fertig' : reason });
    return { results, reason, completed };
  }

  async _prompt(req) {
    // Während der Aufforderung weiter messen (Live-Anzeige von Vout)
    let waiting = true;
    const answered = new Promise((resolve, reject) => {
      this._promptReject = reject;
      Promise.resolve(this.onPrompt?.(req)).then(resolve, reject);
    }).finally(() => { waiting = false; this._promptReject = null; });
    answered.catch(() => {});
    while (waiting) {
      this._check();
      try { await this.sample({ voutNom: req.voutNom, vin: req.vin }); } catch (e) { if (!this.abortReason) throw e; }
      await Promise.race([answered.catch(() => {}), sleep(200)]);
    }
    await answered;
  }

  async _curve(plan, voutNom, vin, results, addDone, progress) {
    const { source: src, sink } = this;
    const det = new SettleDetector(plan.settle);
    const base = { voutNom, vin };

    this._check();
    await sink.setInput(false);
    await src.setVoltage(vin);
    this.recorder?.setPhase(`Vin ${de(vin)} V einstellen`);
    progress({ phase: 'Vin einstellen', voutNom, vin });
    await this._sampleFor(plan.vinSettleMs, base);

    await sink.setCurrent(plan.iouts[0]);
    await sink.setInput(true);
    this._event(`Kennlinie Vin ${de(vin)} V${voutNom != null ? `, Vout ${de(voutNom)} V` : ''}`);

    let voutRef = voutNom;
    let skip = null;
    for (const iout of plan.iouts) {
      const ctx = { ...base, iout };
      if (skip) {
        results.add({ ...base, ioutSet: iout, flag: 'skipped', note: skip, eta: NaN });
        addDone(1);
        continue;
      }
      this._check();
      await sink.setCurrent(iout);
      const phase = `Vin ${de(vin)} V · Iout ${de(iout)} A`;
      this.recorder?.setPhase(phase);
      const t0 = Date.now();
      det.reset(t0);
      let state;
      do {
        this._check();
        const s = await this.sample(ctx);
        state = det.add(s);
        progress({ phase: 'Einschwingen', voutNom, vin, iout, state, spread: det.spread, elapsed: s.t - t0 });
      } while (state !== 'stable' && state !== 'timeout');

      const avg = det.result();
      const [srcStatus, sinkStatus] = await Promise.all([src.status(), sink.status()]);
      const bad = validatePoint(avg, { ioutSet: iout, voutRef, voutTol: plan.voutTol, iinMax: plan.iinMax, srcStatus, sinkStatus });
      const pt = {
        ...base, ioutSet: iout, vinM: avg.vin, iin: avg.iin, pin: avg.pin,
        vout: avg.vout, iout: avg.iout, pout: avg.pout,
        eta: avg.pin > 0 ? avg.pout / avg.pin : NaN, ploss: avg.pin - avg.pout,
        settleMs: Date.now() - t0, samples: avg.n,
        flag: bad ? 'invalid' : state === 'timeout' ? 'timeout' : 'ok',
        note: bad ?? (state === 'timeout' ? 'Timeout – Mittelwert der letzten Messwerte' : ''),
      };
      const acc = src.info.accI;
      if (!bad && acc && avg.iin > 0 && acc[0] + acc[1] / avg.iin > 0.02) {
        pt.lowAccuracy = true;
        pt.note = [pt.note, `Iin klein – Strommessfehler bis ${((acc[0] + acc[1] / avg.iin) * 100).toFixed(1)} %`].filter(Boolean).join('; ');
      }
      if (voutRef == null && !bad) voutRef = avg.vout; // Bezug ohne Vout-Vorgabe: erster gültiger Punkt
      results.add(pt);
      addDone(1);
      this._event(bad ? `ungültig: ${bad}` : `Punkt ${de(iout)} A: η = ${de((pt.eta * 100).toFixed(2))} %${state === 'timeout' ? ' (Timeout)' : ''}`);
      this.onPoint(pt, results);
      if (bad) {
        skip = `übersprungen nach: ${bad}`;
        await sink.setInput(false);
      }
    }
    await sink.setInput(false);
  }

  /** Last aus, dann Quelle aus – Fehler einzeln abfangen. */
  async shutdown() {
    this.recorder?.setPhase('Abschalten');
    try { await this.sink.safeOff(); } catch (e) { this.onEvent(`Last ausschalten fehlgeschlagen: ${e.message}`); }
    try { await this.source.safeOff(); } catch (e) { this.onEvent(`Quelle ausschalten fehlgeschlagen: ${e.message}`); }
  }
}
