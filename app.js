// Oberfläche der Effizienzmessung: Geräteauswahl, Live-Anzeige, Handsteuerung, Messplan,
// Ablauf, Ergebnisplot, Messdateien und Konsole.

import { registry } from './devices/index.js';
import { serialSupported, usbSupported } from './link/serial-link.js';
import { simDut } from './devices/sim.js';
import { SweepPlan } from './sweep/plan.js';
import { SweepRunner } from './sweep/runner.js';
import { ResultSet, FLAG_TEXT } from './sweep/results.js';
import { TimePlot } from './plot.js';
import { EfficiencyPlot } from './effplot.js';
import { RunStore, Recorder, runToCsv, fileName, makeZip } from './runs.js';
import { LogViewer } from './viewer.js';

const $ = (id) => document.getElementById(id);
const store = new RunStore();
const storeOpened = store.open();
const rec = new Recorder(store, () => scheduleFilesRefresh());
const ANDROID = /Android/i.test(navigator.userAgent);

const fmt = (x, d) => (Number.isFinite(x) ? x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
const num = (id) => parseFloat(String($(id).value).replace(',', '.'));

function storageGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// ---------- Konsole / Log ----------
const logEl = $('log');
function log(kind, text) {
  const line = document.createElement('div');
  line.className = kind;
  const prefix = { tx: '→ ', rx: '← ', err: '! ', info: '· ' }[kind] ?? '';
  line.textContent = `${new Date().toLocaleTimeString()}  ${prefix}${text}`;
  logEl.appendChild(line);
  while (logEl.childElementCount > 500) logEl.firstChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}
// Routineabfragen nicht ins Log schreiben
const NOISE = /MEAS|VOUT\?|IOUT\?|STATUS\?|STAT:QUES|TRIP\?|^-?[\d.]+\s*[VAW]?$|^0x[0-9a-f]{2}$/i;

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// ---------- Geräteblöcke ----------
class DeviceSlot {
  constructor(root, kind, label) {
    this.root = root;
    this.kind = kind;
    this.label = label;
    this.key = kind === 'source' ? 'src' : 'sink';
    this.dev = null;
    this.f = (name) => root.querySelector(`[data-f="${name}"]`);
    const sel = this.f('model');
    for (const info of registry.list(kind)) sel.add(new Option(info.name, info.id));
    const saved = storageGet(`eff.${this.key}.model`);
    if (saved && registry.info(saved)) sel.value = saved;
    sel.addEventListener('change', () => { storageSet(`eff.${this.key}.model`, sel.value); this.modelChanged(); });
    this.f('channel').addEventListener('change', () => { storageSet(`eff.${this.key}.ch`, this.f('channel').value); this.showLimits(); });
    this.f('baud').addEventListener('change', () => storageSet(`eff.${this.key}.baud.${sel.value}`, this.f('baud').value));
    this.f('transport').addEventListener('change', () => storageSet(`eff.${this.key}.transport`, this.f('transport').value));
    this.f('connect').addEventListener('click', () => (this.connected ? this.disconnect() : this.connect()));
    this.f('sense').addEventListener('change', () => this.setSense(this.f('sense').checked));
    this.modelChanged(true);
  }

  get info() { return registry.info(this.f('model').value); }
  get connected() { return !!this.dev?.connected; }
  get channel() { return Number(this.f('channel').value) || 1; }

  modelChanged(initial = false) {
    const info = this.info;
    const ch = this.f('channel');
    ch.innerHTML = '';
    info.channels.forEach((c, k) => ch.add(new Option(`${k + 1} (${c.vMax} V / ${c.iMax} A)`, k + 1)));
    const savedCh = initial ? storageGet(`eff.${this.key}.ch`) : null;
    if (savedCh && savedCh <= info.channels.length) ch.value = savedCh;
    this.f('chWrap').hidden = info.channels.length < 2;

    const baud = this.f('baud');
    baud.innerHTML = '';
    for (const b of info.baudRates) baud.add(new Option(b, b));
    baud.value = storageGet(`eff.${this.key}.baud.${info.id}`) ?? info.defaultBaud;
    this.f('baudWrap').hidden = info.sim || !info.baudRates.length;

    const tr = this.f('transport');
    const usbOk = usbSupported() && info.webUsb;
    for (const o of tr.options) o.hidden = o.value === 'usb' ? !usbOk : !serialSupported();
    const savedTr = storageGet(`eff.${this.key}.transport`);
    tr.value = savedTr === 'usb' && usbOk ? 'usb' : savedTr === 'serial' && serialSupported() ? 'serial'
      : (ANDROID || !serialSupported()) && usbOk ? 'usb' : 'serial';
    this.f('transWrap').hidden = !!info.sim;

    const note = [info.note, ANDROID && !info.webUsb && !info.sim ? 'Unter Android nicht nutzbar – am PC über „Seriell“ verbinden.' : '']
      .filter(Boolean).join(' ');
    this.f('note').textContent = note;
    this.f('note').hidden = !note;
    this.f('senseHint').textContent = info.senseControl ? '' : info.senseHint ?? 'nicht per Befehl schaltbar';
    this.showLimits();
    this.update();
  }

  showLimits() {
    const info = this.info;
    const c = info.channels[this.channel - 1];
    this.f('limits').textContent = `Grenzen: ${c.vMax} V · ${c.iMax} A · ${info.pMax} W`;
  }

  setState(text, cls) {
    const s = this.f('state');
    s.textContent = text;
    s.className = `status ${cls}`;
  }

  update() {
    const busy = runner?.active;
    const conn = this.connected;
    for (const n of ['model', 'channel', 'transport', 'baud']) this.f(n).disabled = conn || busy;
    this.f('connect').disabled = !!busy || this.connecting;
    this.f('connect').textContent = conn ? 'Trennen' : 'Verbinden';
    this.f('sense').disabled = !conn || busy || !this.info.senseControl;
    if (!this.connecting) this.setState(conn ? 'verbunden' : 'getrennt', conn ? 'on' : 'off');
  }

  async connect() {
    const info = this.info;
    if (!info.sim && !serialSupported() && !usbSupported()) return;
    this.connecting = true;
    this.setState('verbinde …', 'run');
    this.update();
    const dev = registry.create(info.id, { channel: this.channel });
    dev.link.onLog = (k, t) => { if (k === 'err' || !NOISE.test(t)) log(k, `${this.label}: ${t}`); };
    dev.onDisconnect = () => this.onDisconnected();
    try {
      await dev.connect({ usb: this.f('transport').value === 'usb', baudRate: Number(this.f('baud').value) || info.defaultBaud });
      this.dev = dev;
      this.f('idn').textContent = dev.idn || '—';
      if (!dev.idnMatches()) {
        log('err', `${this.label}: Geräteantwort „${dev.idn}“ passt nicht zu ${info.name} – Auswahl prüfen.`);
        this.f('idn').textContent += ` – passt nicht zu ${info.name}!`;
      }
      log('info', `${this.label} verbunden: ${dev.idn}`);
      try {
        const s = await dev.getSense();
        this.f('sense').checked = !!s;
      } catch (e) {
        log('err', `${this.label}: Sense-Zustand nicht lesbar (${e.message})`);
      }
    } catch (e) {
      if (e.name !== 'NotFoundError') log('err', `${this.label}: Verbinden fehlgeschlagen – ${e.message}`);
    }
    this.connecting = false;
    this.update();
    updateControls();
    schedulePoll(0);
  }

  async disconnect() {
    const dev = this.dev;
    if (!dev) return;
    try { await dev.safeOff(); } catch {}
    if (this.kind === 'source') manual.srcOn = false; else manual.sinkOn = false;
    await dev.disconnect();
  }

  onDisconnected() {
    log('info', `${this.label} getrennt`);
    if (runner?.active) runner.abort(`${this.label} getrennt`);
    this.dev = null;
    this.f('idn').textContent = '—';
    if (this.kind === 'source') manual.srcOn = false; else manual.sinkOn = false;
    this.update();
    updateControls();
  }

  async setSense(on) {
    const out = this.kind === 'source' ? manual.srcOn : manual.sinkOn;
    if (out && !confirm(`${this.label} ist eingeschaltet. Remote Sense trotzdem umschalten?`)) {
      this.f('sense').checked = !on;
      return;
    }
    try {
      await this.dev.setSense(on);
      const now = await this.dev.getSense();
      if (now !== null) this.f('sense').checked = now;
      log('info', `${this.label}: Remote Sense ${on ? 'ein' : 'aus'}`);
    } catch (e) {
      log('err', `${this.label}: ${e.message}`);
      this.f('sense').checked = !on;
    }
  }
}

let runner = null;
const manual = { srcOn: false, sinkOn: false };
const srcSlot = new DeviceSlot($('devSource'), 'source', 'Quelle');
const sinkSlot = new DeviceSlot($('devSink'), 'sink', 'Senke');

// ---------- Live-Anzeige ----------
const history = [];
const plot = new TimePlot($('plot'), [
  { key: 'pin', label: 'Pin', unit: 'W', color: '--c-volt', digits: 3, visible: true },
  { key: 'pout', label: 'Pout', unit: 'W', color: '--c-curr', digits: 3, visible: true },
  { key: 'eta', label: 'η', unit: '%', color: '--c-pow', digits: 2, visible: true },
  { key: 'vin', label: 'Vin', unit: 'V', color: '--c-ext1', digits: 3, visible: false },
  { key: 'vout', label: 'Vout', unit: 'V', color: '--c-ext2', digits: 3, visible: false },
]);
plot.setData(history);
for (const cb of document.querySelectorAll('[data-series]')) {
  plot.panels.find((p) => p.key === cb.dataset.series).visible = cb.checked;
  cb.addEventListener('change', () => {
    plot.panels.find((p) => p.key === cb.dataset.series).visible = cb.checked;
    plot.requestDraw();
  });
}
$('window').addEventListener('change', () => { plot.windowMs = Number($('window').value); plot.requestDraw(); });
plot.windowMs = Number($('window').value);
$('btnClear').addEventListener('click', () => { history.length = 0; plot.requestDraw(); });

function showSample(s) {
  const set = (id, v, d) => { $(id).textContent = fmt(v, d); };
  set('mVin', s.vin, 3); set('mIin', s.iin, 4); set('mPin', s.pin, 3);
  set('mVout', s.vout, 3); set('mIout', s.iout, 4); set('mPout', s.pout, 3);
  set('mEta', s.eta, 2);
  history.push({ t: s.t, pin: s.pin ?? NaN, pout: s.pout ?? NaN, eta: s.eta ?? NaN, vin: s.vin ?? NaN, vout: s.vout ?? NaN });
  if (history.length > 50_000) history.splice(0, history.length - 50_000);
  plot.requestDraw();
  if (prompting) {
    $('promptVout').textContent = fmt(s.vout, 3);
    const d = s.vout - prompting.voutNom;
    $('promptDiff').textContent = Number.isFinite(d) ? `(${d >= 0 ? '+' : ''}${fmt(d, 3)} V)` : '';
  }
}

let pollTimer = null;
function schedulePoll(ms = Number($('interval').value)) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollOnce, ms);
}
async function pollOnce() {
  if (!runner?.active && (srcSlot.connected || sinkSlot.connected)) {
    const s = { t: Date.now() };
    const tasks = [];
    if (srcSlot.connected) tasks.push(srcSlot.dev.measure().then((m) => { s.vin = m.v; s.iin = m.i; s.pin = m.v * m.i; }));
    if (sinkSlot.connected) tasks.push(sinkSlot.dev.measure().then((m) => { s.vout = m.v; s.iout = m.i; s.pout = m.v * m.i; }));
    try {
      await Promise.all(tasks);
      s.eta = s.pin > 1e-4 && s.pout >= 0 ? (s.pout / s.pin) * 100 : NaN;
      showSample(s);
    } catch (e) {
      log('err', `Messung: ${e.message}`);
    }
  }
  schedulePoll();
}
$('interval').addEventListener('change', () => schedulePoll());

// ---------- Handsteuerung ----------
function updateControls() {
  const busy = !!runner?.active;
  const src = srcSlot.connected && !busy, sink = sinkSlot.connected && !busy;
  $('btnManSrcSet').disabled = !src;
  $('btnManSrcOn').disabled = !src;
  $('btnManSinkSet').disabled = !sink;
  $('btnManSinkOn').disabled = !sink;
  $('btnManSrcOn').textContent = manual.srcOn ? 'Quelle AUS' : 'Quelle EIN';
  $('btnManSrcOn').classList.toggle('is-on', manual.srcOn);
  $('btnManSinkOn').textContent = manual.sinkOn ? 'Last AUS' : 'Last EIN';
  $('btnManSinkOn').classList.toggle('is-on', manual.sinkOn);
  $('btnStart').disabled = busy || !srcSlot.connected || !sinkSlot.connected;
  $('btnAbort').disabled = !busy;
  for (const el of $('planCard').querySelectorAll('input, select')) el.disabled = busy;
  srcSlot.update();
  sinkSlot.update();
  const badge = $('runBadge');
  badge.textContent = busy ? 'Messung läuft' : 'bereit';
  badge.className = `status ${busy ? 'run' : 'off'}`;
}

async function guarded(fn) {
  try { await fn(); } catch (e) { log('err', e.message); }
  updateControls();
}
$('btnManSrcSet').addEventListener('click', () => guarded(async () => {
  await srcSlot.dev.setCurrentLimit(num('manIlim'));
  await srcSlot.dev.setVoltage(num('manVin'));
}));
$('btnManSrcOn').addEventListener('click', () => guarded(async () => {
  const on = !manual.srcOn;
  if (on) { await srcSlot.dev.setCurrentLimit(num('manIlim')); await srcSlot.dev.setVoltage(num('manVin')); }
  await srcSlot.dev.setOutput(on);
  manual.srcOn = on;
}));
$('btnManSinkSet').addEventListener('click', () => guarded(async () => {
  await sinkSlot.dev.setCC();
  await sinkSlot.dev.setCurrent(num('manIout'));
}));
$('btnManSinkOn').addEventListener('click', () => guarded(async () => {
  const on = !manual.sinkOn;
  if (on) { await sinkSlot.dev.setCC(); await sinkSlot.dev.setCurrent(num('manIout')); }
  await sinkSlot.dev.setInput(on);
  manual.sinkOn = on;
}));
$('btnAllOff').addEventListener('click', () => guarded(async () => {
  if (runner?.active) runner.abort('Alles AUS gedrückt');
  if (sinkSlot.connected) await sinkSlot.dev.safeOff();
  if (srcSlot.connected) await srcSlot.dev.safeOff();
  manual.srcOn = manual.sinkOn = false;
  log('info', 'Alles aus');
}));

// ---------- Messplan ----------
const PLAN_FIELDS = ['pDut', 'pTopo', 'pDelta', 'pVoutMode', 'pVoutStart', 'pVoutStop', 'pVoutStep', 'pVouts', 'pVinMode', 'pVinStart', 'pVinStop', 'pVinStep', 'pVinList', 'pIoutMode', 'pIoutStart',
  'pIoutStop', 'pIoutStep', 'pIoutList', 'pIinMax', 'pVoutTol', 'pBaseLoad', 'pMinWait', 'pWindow', 'pRelTol', 'pAbsTol',
  'pTimeout', 'pVinSettle'];

function readForm() {
  return {
    dutName: $('pDut').value, voutList: $('pVouts').value,
    voutMode: $('pVoutMode').value, voutStart: num('pVoutStart'), voutStop: num('pVoutStop'), voutStep: num('pVoutStep'), topology: $('pTopo').value, minDelta: num('pDelta'),
    vinMode: $('pVinMode').value, vinStart: num('pVinStart'), vinStop: num('pVinStop'), vinStep: num('pVinStep'), vinList: $('pVinList').value,
    ioutMode: $('pIoutMode').value, ioutStart: num('pIoutStart'), ioutStop: num('pIoutStop'), ioutStep: num('pIoutStep'), ioutList: $('pIoutList').value,
    iinMax: num('pIinMax'), voutTolPct: num('pVoutTol'), baseLoad: num('pBaseLoad') || 0,
    minWaitS: num('pMinWait'), windowS: num('pWindow'), relTolPct: num('pRelTol'), absTolMw: num('pAbsTol') || 0,
    timeoutS: num('pTimeout'), vinSettleS: num('pVinSettle') || 0,
  };
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function planChanged() {
  for (const sel of ['pVinMode', 'pIoutMode', 'pVoutMode']) {
    const mode = $(sel).value;
    document.querySelector(`.mode-range[data-for="${sel}"]`).hidden = mode !== 'range';
    document.querySelector(`.mode-list[data-for="${sel}"]`).hidden = mode !== 'list';
  }
  storageSet('eff.plan', Object.fromEntries(PLAN_FIELDS.map((id) => [id, $(id).value])));
  try {
    const p = SweepPlan.fromForm(readForm());
    $('planInfo').textContent = `${p.pointCount()} Punkt${p.pointCount() === 1 ? '' : 'e'} in ${p.curveCount} Kennlinie${p.curveCount === 1 ? '' : 'n'} · Dauer ca. ${fmtDur(p.estimateDuration())}` +
      (p.vouts.length ? ` + ${p.vouts.filter((v) => p.vinsFor(v).length).length} × Vout einstellen` : '');
    $('planMsg').hidden = true;
    const ex = p.excluded();
    $('planSkip').textContent = ex.length
      ? 'Ausgelassen (Wandlertyp): ' + ex.map((x) => `Vout ${fmt(x.voutNom, 2)} V – Vin ${x.vins.map((v) => fmt(v, 2)).join(' / ')} V`).join(' · ')
      : '';
    $('planSkip').hidden = !ex.length;
  } catch (e) {
    $('planInfo').textContent = e.message;
    $('planSkip').hidden = true;
  }
  $('pDeltaWrap').hidden = $('pTopo').value === 'buckboost';
}
{
  const saved = storageGet('eff.plan') ?? {};
  if (saved.pVoutMode === undefined && saved.pVouts?.trim()) saved.pVoutMode = 'list'; // Pläne vor dem Vout-Modus
  for (const id of PLAN_FIELDS) if (saved[id] !== undefined) $(id).value = saved[id];
  for (const id of PLAN_FIELDS) { $(id).addEventListener('input', planChanged); $(id).addEventListener('change', planChanged); }
  planChanged();
}

function planError(msg) {
  $('planMsg').textContent = msg;
  $('planMsg').hidden = false;
}

// ---------- Aufforderung ----------
let prompting = null; // { voutNom, resolve }
function promptUser(req) {
  return new Promise((resolve) => {
    prompting = { ...req, resolve };
    $('promptV').textContent = `${fmt(req.voutNom, 2)} V`;
    $('promptVin').textContent = `${fmt(req.vin, 2)} V`;
    $('promptVout').textContent = '—';
    $('promptDiff').textContent = '';
    $('promptCard').hidden = false;
    $('promptCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Simulator: das „Poti“ wird automatisch gedreht
    if (srcSlot.info.sim) setTimeout(() => { simDut.vout = req.voutNom; }, 800);
    try { navigator.vibrate?.(200); } catch {}
  });
}
function closePrompt() {
  prompting = null;
  $('promptCard').hidden = true;
}
$('btnPromptOk').addEventListener('click', () => { const p = prompting; closePrompt(); p?.resolve(); });
$('btnPromptCancel').addEventListener('click', () => runner?.abort('vom Nutzer abgebrochen'));

// ---------- Messung ----------
let current = null; // { results, meta }
const effPlot = new EfficiencyPlot($('effPlot'), $('effLegend'), $('effHover'));
$('effLog').checked = !!storageGet('eff.logx');
effPlot.logX = $('effLog').checked;
$('effLog').addEventListener('change', () => { effPlot.logX = $('effLog').checked; storageSet('eff.logx', effPlot.logX); effPlot.requestDraw(); });

const EXTRA_COLS = [
  { key: 'vin_V', digits: 4 }, { key: 'iin_A', digits: 4 }, { key: 'pin_W', digits: 4 }, { key: 'eta_pct', digits: 3 },
  { key: 'vout_nenn_V', digits: 3, hidden: true }, { key: 'vin_soll_V', digits: 3, hidden: true }, { key: 'iout_soll_A', digits: 4, hidden: true },
];

async function startRun() {
  let plan;
  try {
    plan = SweepPlan.fromForm(readForm());
  } catch (e) {
    planError(e.message);
    return;
  }
  const src = srcSlot.dev, sink = sinkSlot.dev;
  const errs = plan.check(src.limits, sink.limits);
  if (errs.length) { planError(errs.join(' ')); return; }
  if (sinkSlot.f('sense').checked) {
    try {
      const st = await sink.status();
      if (st.senseMissing) { planError('Remote Sense der Last ist eingeschaltet, aber die Sense-Leitungen sind nicht angeschlossen.'); return; }
    } catch {}
  }
  $('planMsg').hidden = true;

  const devText = (slot) => `${slot.info.name}${slot.info.channels.length > 1 ? ` Kanal ${slot.channel}` : ''} (${slot.dev.idn})`;
  const sense = (slot) => (slot.info.senseControl ? (slot.f('sense').checked ? 'ein' : 'aus') : 'am Gerät');
  const params = {
    Wandler: plan.dutName || '—',
    Quelle: devText(srcSlot), Sense_Quelle: sense(srcSlot),
    Senke: devText(sinkSlot), Sense_Senke: sense(sinkSlot),
    ...plan.toParams(),
  };
  const name = `Effizienz ${plan.dutName || 'DC/DC'}`;
  const meta = rec.start('eff', name, { params, extraCols: EXTRA_COLS });
  meta.baseNames = ['vout_V', 'iout_A', 'pout_W'];
  meta.baseLabels = ['Vout', 'Iout', 'Pout'];
  meta.results = [];

  const results = new ResultSet({ name, dut: plan.dutName, startT: meta.startT, params });
  current = { results, meta };
  renderResults();
  manual.srcOn = manual.sinkOn = false;
  const t0 = Date.now();

  runner = new SweepRunner({
    source: src, sink, recorder: rec,
    onSample: showSample,
    onPrompt: promptUser,
    onEvent: (t) => log('info', t),
    onProgress: (p) => {
      $('sProg').textContent = `${p.done} / ${p.total}`;
      if (p.iout !== undefined) $('sPoint').textContent = `Vin ${fmt(p.vin, 1)} V · ${fmt(p.iout, 3)} A`;
      else if (p.vin !== undefined) $('sPoint').textContent = `Vin ${fmt(p.vin, 1)} V`;
      $('sSettle').textContent = p.phase !== 'Einschwingen' ? p.phase
        : p.state === 'wait' ? `warten ${fmt(p.elapsed / 1000, 0)} s`
          : p.spread != null ? `±${fmt(p.spread * 50, 2)} %` : '…';
      if (p.done > 0 && p.done < p.total) $('sEta').textContent = fmtDur(((Date.now() - t0) / p.done) * (p.total - p.done));
    },
    onPoint: (pt, res) => {
      results.points = res.points;
      meta.results = res.points;
      renderResults();
    },
  });
  const pending = runner.run(plan, { name, dut: plan.dutName, startT: meta.startT }); // setzt runner.active sofort
  updateControls();
  const out = await pending;
  closePrompt();
  results.points = out.results.points;
  meta.results = out.results.points;
  const ok = out.results.points.filter((p) => p.flag === 'ok' || p.flag === 'timeout').length;
  await rec.end(out.completed ? 'Messung abgeschlossen' : out.reason, { Ergebnis: `${ok} von ${plan.pointCount()} Punkten gültig` });
  $('sEta').textContent = '—';
  $('sSettle').textContent = out.completed ? 'fertig' : out.reason;
  log(out.completed ? 'info' : 'err', out.completed ? `Messung abgeschlossen: ${ok} gültige Punkte` : `Messung beendet: ${out.reason}`);
  renderResults();
  updateControls();
}
$('btnStart').addEventListener('click', () => startRun().catch((e) => { log('err', e.message); updateControls(); }));
$('btnAbort').addEventListener('click', () => runner?.abort('vom Nutzer abgebrochen'));

// ---------- Ergebnis ----------
function renderResults() {
  const res = current?.results;
  effPlot.setResults(res ?? null);
  const tbody = $('resTable').tBodies[0];
  tbody.innerHTML = '';
  for (const p of res?.points ?? []) {
    const tr = tbody.insertRow();
    tr.className = `flag-${p.flag}`;
    const cells = [
      p.voutNom == null ? '—' : fmt(p.voutNom, 2), fmt(p.vin, 2), fmt(p.ioutSet, 3), fmt(p.vinM, 3), fmt(p.iin, 4), fmt(p.pin, 3),
      fmt(p.vout, 3), fmt(p.iout, 4), fmt(p.pout, 3), Number.isFinite(p.eta) ? `${fmt(p.eta * 100, 2)} %` : '—', fmt(p.ploss, 3),
      p.settleMs ? `${fmt(p.settleMs / 1000, 1)} s` : '—',
    ];
    for (const c of cells) tr.insertCell().textContent = c;
    const st = tr.insertCell();
    st.textContent = FLAG_TEXT[p.flag] ?? p.flag;
    if (p.note) st.title = p.note;
    if (p.lowAccuracy) st.textContent += ' (ungenau)';
  }
  const n = res?.points.length ?? 0;
  $('btnPng').disabled = !n;
  $('btnResCsv').disabled = !n;
  if (res) {
    const ok = res.points.filter((p) => p.flag === 'ok' || p.flag === 'timeout').length;
    $('resInfo').textContent = `${res.meta.name ?? ''} · ${new Date(res.meta.startT ?? Date.now()).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })} · ${ok} gültige von ${n} Punkten`;
  }
}

function showStoredResult(meta) {
  if (!meta.results?.length) { log('err', 'Diese Datei enthält keine Messpunkte.'); return; }
  current = {
    meta,
    results: new ResultSet({ name: meta.name, dut: meta.params?.Wandler === '—' ? '' : meta.params?.Wandler, startT: meta.startT, params: meta.params }, meta.results),
  };
  renderResults();
  $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('btnPng').addEventListener('click', async () => {
  if (!current) return;
  downloadBlob(await effPlot.toPng(), fileName(current.meta).replace(/\.csv$/, '_wirkungsgrad.png'));
});
$('btnResCsv').addEventListener('click', () => {
  if (!current) return;
  downloadBlob(new Blob([current.results.toCsv(csvFormat())], { type: 'text/csv' }), fileName(current.meta).replace(/\.csv$/, '_ergebnis.csv'));
});

// ---------- CSV-Format ----------
const csvFormat = () => $('csvFormat').value;
$('csvFormat').value = storageGet('eff.csv') ?? 'de';
$('csvFormat').addEventListener('change', () => storageSet('eff.csv', csvFormat()));
$('interval').value = storageGet('eff.interval') ?? '1000';
$('interval').addEventListener('change', () => storageSet('eff.interval', $('interval').value));

// ---------- Messdateien ----------
let fileList = [];
const selectedFiles = new Set();
let filesTimer = null;

function scheduleFilesRefresh() {
  if (filesTimer) return;
  filesTimer = setTimeout(() => { filesTimer = null; refreshFiles(); }, 200);
}

async function refreshFiles() {
  try {
    fileList = await store.list();
  } catch (e) {
    log('err', `Messdateien nicht lesbar: ${e.message}`);
    fileList = [];
  }
  const active = rec.run?.meta;
  if (active) {
    fileList = fileList.filter((m) => m.id !== active.id);
    fileList.push(active);
  }
  fileList.sort((a, b) => b.startT - a.startT);
  for (const id of [...selectedFiles]) if (!fileList.some((m) => m.id === id)) selectedFiles.delete(id);
  renderFiles();
}

function renderFiles() {
  const tbody = $('filesTable').tBodies[0];
  tbody.innerHTML = '';
  const activeId = rec.run?.meta.id;
  for (const meta of fileList) {
    const tr = tbody.insertRow();
    const isActive = meta.id === activeId;
    tr.classList.toggle('active', isActive);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedFiles.has(meta.id);
    cb.setAttribute('aria-label', `${meta.name} auswählen`);
    cb.addEventListener('change', () => {
      cb.checked ? selectedFiles.add(meta.id) : selectedFiles.delete(meta.id);
      updateFileButtons();
    });
    tr.insertCell().appendChild(cb);

    const name = tr.insertCell();
    const title = document.createElement('span');
    title.className = 'fname';
    title.textContent = meta.name;
    const sub = document.createElement('span');
    sub.className = 'fsub';
    sub.textContent = isActive ? 'läuft …' : meta.endT ? [meta.endReason, meta.params?.Ergebnis].filter(Boolean).join(' · ') : 'nicht abgeschlossen (Seite geschlossen oder Absturz)';
    name.append(title, sub);

    tr.insertCell().textContent = new Date(meta.startT).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' });
    const endT = meta.endT ?? (isActive ? Date.now() : meta.lastT ?? meta.startT);
    tr.insertCell().textContent = fmtDur(endT - meta.startT);
    tr.insertCell().textContent = meta.count.toLocaleString('de-DE');

    const actions = tr.insertCell();
    const res = document.createElement('button');
    res.textContent = 'Ergebnis';
    res.title = 'Messpunkte im Wirkungsgrad-Plot anzeigen';
    res.disabled = !meta.results?.length;
    res.addEventListener('click', () => showStoredResult(meta));
    const view = document.createElement('button');
    view.textContent = 'Ansehen';
    view.title = 'Verlauf im Diagramm ansehen (Zoom, Cursor)';
    view.addEventListener('click', () => viewer.open(meta).catch((e) => log('err', `Messdatei nicht lesbar: ${e.message}`)));
    const dl = document.createElement('button');
    dl.textContent = 'CSV';
    dl.title = 'Alle Abtastwerte als CSV herunterladen';
    dl.addEventListener('click', () => downloadFiles([meta.id]));
    const del = document.createElement('button');
    del.textContent = 'Löschen';
    del.disabled = isActive;
    del.addEventListener('click', () => deleteFiles([meta.id]));
    actions.append(res, view, dl, del);
  }
  $('filesEmpty').hidden = fileList.length > 0;
  $('filesInfo').textContent = `${fileList.length} Datei${fileList.length === 1 ? '' : 'en'}` +
    (store.persistent ? '' : ' · nur bis zum Neuladen (Browser-Speicher nicht verfügbar)');
  updateFileButtons();
}

function updateFileButtons() {
  const n = selectedFiles.size;
  $('btnFilesDl').disabled = n === 0;
  $('btnFilesDl').textContent = n ? `${n} ausgewählte herunterladen` : 'Ausgewählte herunterladen';
  $('btnFilesDel').disabled = n === 0;
  $('btnFilesAll').disabled = fileList.length === 0;
  $('filesAllCb').checked = n > 0 && n === fileList.length;
  $('filesAllCb').indeterminate = n > 0 && n < fileList.length;
}

async function fileCsv(meta) {
  if (meta.id === rec.run?.meta.id) await rec.flushNow();
  return runToCsv(meta, await store.rows(meta.id), csvFormat());
}

async function downloadFiles(ids) {
  const metas = fileList.filter((m) => ids.includes(m.id));
  if (!metas.length) return;
  try {
    if (metas.length === 1) {
      downloadBlob(new Blob([await fileCsv(metas[0])], { type: 'text/csv' }), fileName(metas[0]));
      return;
    }
    const files = [];
    for (const meta of metas) {
      files.push({ name: fileName(meta), data: await fileCsv(meta) });
      if (meta.results?.length) {
        const rs = new ResultSet({ name: meta.name, startT: meta.startT, params: meta.params }, meta.results);
        files.push({ name: fileName(meta).replace(/\.csv$/, '_ergebnis.csv'), data: rs.toCsv(csvFormat()) });
      }
    }
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    downloadBlob(makeZip(files), `effizienz_messdateien_${stamp}_${metas.length}.zip`);
  } catch (e) {
    log('err', `Download fehlgeschlagen: ${e.message}`);
  }
}

async function deleteFiles(ids) {
  const activeId = rec.run?.meta.id;
  const del = ids.filter((id) => id !== activeId);
  if (!del.length) return;
  if (!confirm(`${del.length === 1 ? 'Messdatei' : `${del.length} Messdateien`} endgültig löschen?`)) return;
  for (const id of del) {
    try { await store.remove(id); } catch (e) { log('err', e.message); }
    selectedFiles.delete(id);
    if (viewer.id === id) viewer.close();
  }
  refreshFiles();
}

const viewer = new LogViewer($('viewerCard'), {
  load: async (meta) => {
    if (meta.id === rec.run?.meta.id) await rec.flushNow();
    return store.rows(meta.id);
  },
});
setInterval(() => {
  if (viewer.id && viewer.id === rec.run?.meta.id) viewer.reload().catch(() => {});
}, 5000);

$('filesAllCb').addEventListener('change', () => {
  if ($('filesAllCb').checked) fileList.forEach((m) => selectedFiles.add(m.id));
  else selectedFiles.clear();
  renderFiles();
});
$('btnFilesDl').addEventListener('click', () => downloadFiles([...selectedFiles]));
$('btnFilesAll').addEventListener('click', () => downloadFiles(fileList.map((m) => m.id)));
$('btnFilesDel').addEventListener('click', () => deleteFiles([...selectedFiles]));
setInterval(() => { if (rec.active) renderFiles(); }, 2000);

// ---------- Konsole ----------
$('consoleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cmd = $('cmd').value.trim();
  const slot = $('cmdTarget').value === 'source' ? srcSlot : sinkSlot;
  if (!cmd) return;
  if (!slot.connected) { log('err', `${slot.label} ist nicht verbunden.`); return; }
  try {
    log('tx', `${slot.label}: ${cmd}`);
    const r = await slot.dev.console(cmd);
    if (r) log('rx', `${slot.label}: ${r}`);
    $('cmd').value = '';
  } catch (err) {
    log('err', err.message);
  }
});

// ---------- Start ----------
window.addEventListener('beforeunload', (e) => {
  if (runner?.active || manual.srcOn || manual.sinkOn) {
    // best effort: Last aus, dann Quelle aus
    sinkSlot.dev?.safeOff().catch(() => {});
    srcSlot.dev?.safeOff().catch(() => {});
    e.preventDefault();
    e.returnValue = '';
  }
});

if (!serialSupported() && !usbSupported()) $('unsupported').hidden = false;
updateControls();
storeOpened.then(() => refreshFiles());
