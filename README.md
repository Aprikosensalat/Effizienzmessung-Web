# Effizienzmessung DC/DC-Wandler

Browser-Anwendung zur Wirkungsgradmessung von DC/DC-Wandlern: Ein **Netzteil (Quelle)** speist den
Wandler, eine **elektronische Last (Senke)** belastet den Ausgang. Die Website fährt alle Kombinationen aus
Ausgangsspannung, Eingangsspannung und Ausgangsstrom an, wartet auf einen eingeschwungenen Betriebspunkt und
berechnet **η = Pout / Pin**. Schwesterprojekt zu *KEL103-Web* und *KWR103-Web*; reines HTML/CSS/JavaScript,
kein Build, keine Abhängigkeiten.

Planung mit Klassen-, Sequenz- und Zustandsdiagramm: [PLANUNG.md](PLANUNG.md)

## Geräte

| Quelle | Senke |
|---|---|
| KORAD KWR103 *(am Gerät geprüft)* | KORAD KEL103 *(am Gerät geprüft)* |
| KORAD KA3005P *(am Gerät geprüft, 9600 Baud, kein Remote Sense)* | |
| R&S NGP802 / 822 / 804 / 814 / 824 *(nach Handbuch)* | ITECH IT8514C+ *(nach Handbuch)* |
| R&S HMP2020 / 2030 / 4030 / 4040 *(nach Handbuch)* | Simulator |
| Simulator | |

Der **Simulator** (Quelle und Senke mit einem Wandler-Modell) zeigt den kompletten Ablauf ohne Hardware.

Hinweise zu den Geräten:
- **NGP800**: am Gerät USB-Klasse **CDC** einstellen (Netzwerkverbindungen → USB Class), danach Neustart.
- **HMP**: Schnittstelle im Menü (MENU → INTERFACE) auf USB-VCP oder RS-232; Baudrate wie am Gerät.
  Remote Sense nur über die Sense-Klemmen am Gerät.
- **IT8514C+**: USB ist ein Prolific-Seriell-Wandler (Treiber IT-E122), Baudrate am Gerät (Shift + 8)
  und auf der Website gleich einstellen; nicht DB9 und USB gleichzeitig anschließen.
- **Android** (WebUSB): USB-CDC (KORAD, NGP800 – geprüft mit KORAD), Prolific PL2303 (IT8514C+) und FTDI
  (HMP mit HO720/HO730). PL2303 und FTDI sind nach den Linux-Treibern umgesetzt, aber nicht an Hardware geprüft.

## Starten

Nur in **Chrome / Edge** und in sicherem Kontext (`https://` oder `http://localhost`):

```sh
python -m http.server 8002
```

Dann <http://localhost:8002> öffnen, Quelle und Senke wählen und jeweils **Verbinden** klicken
(eine Seite kann beide seriellen Ports gleichzeitig öffnen).

## Ablauf einer Messung

1. **Messplan**: Wandlertyp (Buck, Boost, Buck/Boost) mit Mindestabstand zwischen Vin und Vout,
   Ausgangsspannungen (keine, Start/Stop/Schritt oder Liste – stellst du am Wandler ein), Eingangsspannungen und Ausgangsströme als
   Start/Stop/Schritt oder Liste (`0,1; 0,5; 1; 2`), max. Eingangsstrom, Vout-Toleranz, Einschwing-Parameter.
   Eingangsspannungen, die nicht zum Wandlertyp passen (Buck: Vin ≥ Vout + Abstand, Boost: Vin ≤ Vout − Abstand),
   werden für die jeweilige Ausgangsspannung ausgelassen. Ohne Liste der Ausgangsspannungen wird vor jeder
   Kennlinie die gemessene Leerlauf-Ausgangsspannung geprüft.
2. **Je Ausgangsspannung**: Die Quelle schaltet mit der ersten Eingangsspannung ein, die Website fordert auf,
   den Wandler auf die Spannung einzustellen (Live-Anzeige von Vout), dann **Übernehmen**.
3. **Je Eingangsspannung**: Last aus, Vin einstellen, kurz warten, dann die Ströme **aufsteigend** anfahren.
4. **Je Punkt**: nach der Mindestwartezeit wird geprüft, ob sich Pin und Pout über das Zeitfenster um weniger als
   die Schwelle ändern; Messwert = Mittelwert über das Fenster. Nach dem Timeout wird der Punkt mit Hinweis übernommen.
5. **Ungültige Punkte** (Vout eingebrochen, Quelle in Strombegrenzung, Last erreicht den Strom nicht, Schutz
   ausgelöst): Rest der Kennlinie wird übersprungen, weiter mit der nächsten Eingangsspannung.
6. **Ende oder Abbruch**: immer zuerst Last aus, dann Quelle aus.

Punkte mit kleinem Eingangsstrom werden als „ungenau“ markiert, wenn der Strommessfehler der Quelle
(z. B. KWR103: 0,1 % + 3 mA) mehr als 2 % ausmacht.

## Ergebnis und Dateien

- **Wirkungsgrad-Plot**: η über Iout, Farbe je Vin, Strichart je Vout; Strom linear oder logarithmisch;
  Kurven per Legende ein-/ausblenden; Export als **PNG** und **SVG** (Vektorgrafik, beide mit Titel und Legende)
  und **CSV** (ein Punkt je Zeile).
- **Messdateien**: jede Messung als eigene Datei mit allen Abtastwerten (`vout_V`, `iout_A`, `pout_W`, `vin_V`,
  `iin_A`, `pin_W`, `eta_pct`, Sollwerte, Spalte `info` mit Phase und Ereignissen). „Ergebnis“ lädt die Messpunkte
  einer gespeicherten Messung in den Plot, „Ansehen“ öffnet den Verlauf mit Zoom und Cursorn, ZIP-Download.

## Neues Gerät hinzufügen

1. Klasse in `devices/` anlegen, die `Source` (Netzteil) oder `Sink` (Last) aus `devices/base.js` erweitert:
   `setVoltage`, `setCurrentLimit`, `setOutput`, `measure`, `status` bzw. `setCC`, `setCurrent`, `setInput`,
   `measure`, `status`; optional `init`, `release`, `setSense`, `getSense`, `prepare`.
2. In `devices/index.js` mit `registry.register({ id, name, kind, channels, pMax, baudRates, … }, factory)`
   eintragen. Dropdown, Kanalwahl, Grenzen und Sense-Schalter richten sich danach.

Hersteller-PDFs im Ordner sind per `.gitignore` vom Repository ausgeschlossen.
