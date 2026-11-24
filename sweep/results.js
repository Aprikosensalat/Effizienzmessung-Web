// Messpunkte, Kennlinien und Ergebnis-CSV.

import { formatTime } from '../runs.js';

export const FLAG_TEXT = { ok: 'ok', timeout: 'nicht eingeschwungen', invalid: 'ungültig', skipped: 'übersprungen' };

/** Kennlinien-Schlüssel und -Beschriftung. */
export function curveKey(p) {
  return `${p.voutNom ?? '-'}|${p.vin}`;
}

export function curveLabel(voutNom, vin) {
  const n = (x) => String(x).replace('.', ',');
  return voutNom == null ? `Vin ${n(vin)} V` : `Vout ${n(voutNom)} V · Vin ${n(vin)} V`;
}

export class ResultSet {
  constructor(meta = {}, points = []) {
    this.meta = meta;     // { name, dut, source, sink, startT, params }
    this.points = points; // MeasurementPoint[]
  }

  add(point) {
    this.points.push(point);
  }

  /** Kennlinien in Messreihenfolge: [{ key, voutNom, vin, label, points }] */
  curves() {
    const map = new Map();
    for (const p of this.points) {
      const k = curveKey(p);
      if (!map.has(k)) map.set(k, { key: k, voutNom: p.voutNom, vin: p.vin, label: curveLabel(p.voutNom, p.vin), points: [] });
      map.get(k).points.push(p);
    }
    return [...map.values()];
  }

  toCsv(fmt = 'de') {
    const de = fmt === 'de';
    const sep = de ? ';' : ',';
    const num = (x, d) => (typeof x !== 'number' || !Number.isFinite(x) ? '' : de ? x.toFixed(d).replace('.', ',') : x.toFixed(d));
    const text = (s) => {
      const str = String(s ?? '');
      return str.includes(sep) || /["\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const localize = (v) => (de ? String(v).replace(/(\d)\.(\d)/g, '$1,$2') : String(v));
    const lines = [];
    const head = (k, v) => lines.push([text(`# ${k}`), text(v)].join(sep));
    head('Messung', this.meta.name ?? 'Effizienzmessung');
    if (this.meta.startT) head('Start', formatTime(this.meta.startT, fmt));
    if (this.meta.dut && !this.meta.params?.Wandler) head('Wandler', this.meta.dut);
    for (const [k, v] of Object.entries(this.meta.params ?? {})) head(k, localize(v));
    lines.push('');
    lines.push(['vout_nenn_V', 'vin_soll_V', 'iout_soll_A', 'vin_V', 'iin_A', 'pin_W', 'vout_V', 'iout_A', 'pout_W',
      'wirkungsgrad_pct', 'verlust_W', 'einschwingzeit_s', 'status', 'hinweis'].join(sep));
    for (const p of this.points) {
      lines.push([
        num(p.voutNom, 3), num(p.vin, 3), num(p.ioutSet, 4), num(p.vinM, 4), num(p.iin, 4), num(p.pin, 4),
        num(p.vout, 4), num(p.iout, 4), num(p.pout, 4), num(p.eta * 100, 3), num(p.ploss, 4),
        num(p.settleMs / 1000, 1), text(FLAG_TEXT[p.flag] ?? p.flag), text(p.note),
      ].join(sep));
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }
}
