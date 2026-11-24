// Messplan: Ausgangsspannungen (Aufforderung an den Nutzer), Eingangsspannungen, Ausgangsströme,
// Grenzen und Einschwing-Parameter.

const round = (x) => Math.round(x * 1e6) / 1e6;

export const ValueList = {
  /** Start/Stop/Schritt (einschließlich Stop). */
  range(start, stop, step) {
    if (![start, stop, step].every(Number.isFinite)) throw new Error('Start, Stop und Schritt müssen Zahlen sein.');
    if (step <= 0) throw new Error('Der Schritt muss größer als 0 sein.');
    if (stop < start) throw new Error('Stop muss größer oder gleich Start sein.');
    const n = Math.floor((stop - start) / step + 1e-9);
    if (n > 1000) throw new Error('Zu viele Punkte (über 1000).');
    const out = [];
    for (let k = 0; k <= n; k++) out.push(round(start + k * step));
    if (stop - out[out.length - 1] > step * 1e-6) out.push(round(stop));
    return out;
  },

  /** Freie Liste „0,1; 0,5; 1; 2“ (Trennzeichen ; Leerzeichen oder Zeilenumbruch, Komma oder Punkt als Dezimalzeichen). */
  parse(text) {
    const tokens = String(text ?? '').split(/[;\s]+/).map((t) => t.trim()).filter(Boolean);
    return tokens.map((t) => {
      const v = Number(t.replace(',', '.'));
      if (!Number.isFinite(v)) throw new Error(`„${t}“ ist keine Zahl.`);
      return v;
    });
  },
};

export const DEFAULT_SETTLE = {
  minWaitMs: 2000,  // Mindestwartezeit nach dem Einstellen
  windowMs: 3000,   // Zeitfenster für die Stabilitätsprüfung und den Mittelwert
  relTol: 0.002,    // erlaubte Änderung von Pin und Pout im Fenster (relativ)
  absTolW: 0.002,   // … oder absolut (W) – für kleine Leistungen
  timeoutMs: 30000, // danach wird der Punkt mit Warnung übernommen
};

export class SweepPlan {
  constructor(p) {
    this.dutName = p.dutName ?? '';
    this.vouts = p.vouts ?? [];          // Nennwerte; leer = keine Aufforderung
    this.vins = p.vins;
    this.iouts = [...new Set(p.iouts)].sort((a, b) => a - b); // immer aufsteigend
    this.iinMax = p.iinMax;              // Strombegrenzung der Quelle
    this.voutTol = p.voutTol ?? 0.1;     // Vout darf so weit unter den Bezugswert fallen
    this.baseLoad = p.baseLoad ?? 0;     // Grundlast während der Vout-Aufforderung
    this.vinSettleMs = p.vinSettleMs ?? 1500;
    this.settle = { ...DEFAULT_SETTLE, ...(p.settle ?? {}) };
    this.topology = p.topology ?? 'buckboost'; // 'buck' | 'boost' | 'buckboost'
    this.minDelta = p.minDelta ?? 0;           // Mindestabstand zwischen Vin und Vout (V)
  }

  /** Passt die Kombination zum Wandlertyp? Buck: Vin ≥ Vout + Abstand, Boost: Vin ≤ Vout − Abstand. */
  allowed(vin, vout) {
    if (vout == null || !Number.isFinite(vout)) return true;
    if (this.topology === 'buck') return vin >= vout + this.minDelta - 1e-9;
    if (this.topology === 'boost') return vin <= vout - this.minDelta + 1e-9;
    return true;
  }

  /** Eingangsspannungen, die zu einer Ausgangsspannung passen (Reihenfolge wie im Plan). */
  vinsFor(voutNom) {
    return this.vins.filter((vin) => this.allowed(vin, voutNom));
  }

  /** Ausgelassene Kombinationen: [{ voutNom, vins: [...] }] */
  excluded() {
    return this.vouts
      .map((voutNom) => ({ voutNom, vins: this.vins.filter((vin) => !this.allowed(vin, voutNom)) }))
      .filter((x) => x.vins.length);
  }

  get topologyText() {
    return { buck: 'Buck', boost: 'Boost', buckboost: 'Buck/Boost' }[this.topology] ?? this.topology;
  }

  /** Aus den Formularwerten; wirft bei ungültigen Eingaben. */
  static fromForm(f) {
    const list = (mode, start, stop, step, text, what) => {
      const v = mode === 'list' ? ValueList.parse(text) : ValueList.range(start, stop, step);
      if (!v.length) throw new Error(`Keine ${what} angegeben.`);
      if (v.some((x) => x < 0)) throw new Error(`${what}: negative Werte sind nicht erlaubt.`);
      return v;
    };
    const vins = list(f.vinMode, f.vinStart, f.vinStop, f.vinStep, f.vinList, 'Eingangsspannungen');
    const iouts = list(f.ioutMode, f.ioutStart, f.ioutStop, f.ioutStep, f.ioutList, 'Ausgangsströme');
    if (vins.some((v) => v <= 0)) throw new Error('Eingangsspannungen müssen größer als 0 sein.');
    // Ausgangsspannungen: keine (ohne Aufforderung), Start/Stop/Schritt oder Liste; alte Pläne ohne Modus = Liste
    const voutMode = f.voutMode ?? 'list';
    const vouts = voutMode === 'none' ? []
      : list(voutMode, f.voutStart, f.voutStop, f.voutStep, f.voutList, 'Ausgangsspannungen');
    if (vouts.some((v) => v <= 0)) throw new Error('Ausgangsspannungen müssen größer als 0 sein.');
    if (!(f.iinMax > 0)) throw new Error('Max. Eingangsstrom muss größer als 0 sein.');
    return new SweepPlan({
      dutName: f.dutName.trim(), vouts, vins, iouts, iinMax: f.iinMax,
      voutTol: f.voutTolPct / 100, baseLoad: f.baseLoad, vinSettleMs: f.vinSettleS * 1000,
      topology: f.topology, minDelta: f.topology === 'buckboost' ? 0 : Math.max(0, f.minDelta || 0),
      settle: {
        minWaitMs: f.minWaitS * 1000, windowMs: f.windowS * 1000, relTol: f.relTolPct / 100,
        absTolW: f.absTolMw / 1000, timeoutMs: f.timeoutS * 1000,
      },
    });
  }

  get curveCount() {
    return this.vouts.length ? this.vouts.reduce((n, v) => n + this.vinsFor(v).length, 0) : this.vins.length;
  }

  pointCount() {
    return this.curveCount * this.iouts.length;
  }

  /** Grobe Dauer in ms (ohne Wartezeit auf den Nutzer). */
  estimateDuration() {
    const perPoint = this.settle.minWaitMs + this.settle.windowMs + 600;
    return this.pointCount() * perPoint + this.curveCount * (this.vinSettleMs + 1500);
  }

  /** Prüft den Plan gegen die Grenzen der Geräte; liefert eine Liste von Fehlern. */
  check(srcLimits, sinkLimits) {
    const err = [];
    const vinMax = Math.max(...this.vins), ioutMax = Math.max(...this.iouts);
    if (this.curveCount === 0) err.push(`Keine Eingangsspannung passt zu den Ausgangsspannungen (${this.topologyText}, Abstand ${this.minDelta} V).`);
    if (vinMax > srcLimits.vMax) err.push(`Eingangsspannung ${vinMax} V über dem Maximum der Quelle (${srcLimits.vMax} V).`);
    if (this.iinMax > srcLimits.iMax) err.push(`Max. Eingangsstrom ${this.iinMax} A über dem Maximum der Quelle (${srcLimits.iMax} A).`);
    if (ioutMax > sinkLimits.iMax) err.push(`Ausgangsstrom ${ioutMax} A über dem Maximum der Last (${sinkLimits.iMax} A).`);
    if (this.baseLoad > sinkLimits.iMax) err.push('Grundlast über dem Maximum der Last.');
    const voutMax = Math.max(0, ...this.vouts);
    if (voutMax && voutMax * ioutMax > sinkLimits.pMax) {
      err.push(`Ausgangsleistung bis ${(voutMax * ioutMax).toFixed(1)} W über dem Maximum der Last (${sinkLimits.pMax} W).`);
    }
    return err;
  }

  toParams() {
    const s = this.settle;
    return {
      Wandlertyp: this.topology === 'buckboost' ? this.topologyText : `${this.topologyText}, Mindestabstand ${this.minDelta} V`,
      Ausgangsspannungen_V: this.vouts.length ? this.vouts.join(' / ') : 'keine Vorgabe',
      Eingangsspannungen_V: this.vins.join(' / '),
      Ausgangsstroeme_A: this.iouts.join(' / '),
      max_Eingangsstrom_A: this.iinMax,
      Vout_Toleranz_pct: this.voutTol * 100,
      Grundlast_A: this.baseLoad,
      Einschwingen: `min ${s.minWaitMs / 1000} s, Fenster ${s.windowMs / 1000} s, ${s.relTol * 100} % / ${s.absTolW * 1000} mW, Timeout ${s.timeoutMs / 1000} s`,
    };
  }
}
