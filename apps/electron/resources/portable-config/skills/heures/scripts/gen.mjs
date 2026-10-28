#!/usr/bin/env node
// Générateur déterministe pour /heures — NE PAS MODIFIER à la main.
// Entrées : ~/.claude/heures/<date>/{conductor,slack,calendar,git}.csv (TSV, triés)
// Sorties : heures.html (même contenu à chaque run pour les mêmes CSV) + récap stdout.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const date = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) { console.error('usage: node gen.mjs YYYY-MM-DD'); process.exit(1); }
const dir = `${process.env.HOME}/.claude/heures/${date}`;

// Fenêtre de journée : [04:00 locale, 04:00 locale J+1) — 96 tranches de 15 min
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone; // TZ de la machine
const offSec = (() => {
  const v = new Intl.DateTimeFormat('en', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${date}T12:00:00Z`)).find(p => p.type === 'timeZoneName').value;
  const m = v.match(/([+-])(\d{2}):(\d{2})/); return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 3600 + +m[3] * 60) : 0;
})();
const BUCKET = 900, N = 96;
const t0 = Date.parse(`${date}T04:00:00Z`) / 1000 - offSec;
const t1 = t0 + N * BUCKET;

const read = f => existsSync(`${dir}/${f}`)
  ? readFileSync(`${dir}/${f}`, 'utf8').split('\n').map(l => l.trimEnd()).filter(Boolean).map(l => l.split('\t'))
  : null;
const src = { conductor: read('conductor.csv'), slack: read('slack.csv'), calendar: read('calendar.csv'), git: read('git.csv') };

const cls = new Array(N).fill('.');            // '.' vide · W attente Claude · A actif · M meeting
const aLab = Array.from({ length: N }, () => []), mLab = Array.from({ length: N }, () => []), wLab = Array.from({ length: N }, () => []);
const idx = t => Math.floor((t - t0) / BUCKET);
const inWin = t => t >= t0 && t < t1;
// names.tsv (label brut ⇥ nom concret) : cache global écrit par /heures, label brut si absent
const names = new Map((read('../names.tsv') || []).map(([k, v]) => [k, v]));
const add = (arr, i, l) => { l = (l || '').trim(); l = names.get(l) || l; if (l && !arr[i].includes(l)) arr[i].push(l); };

// passe 1 : attente (assistant Conductor) — priorité la plus faible
if (src.conductor) for (const [role, e, label] of src.conductor)
  if (role !== 'user' && inWin(+e)) { const i = idx(+e); if (cls[i] === '.') cls[i] = 'W'; add(wLab, i, label); }
// passe 2 : actions d'Antoine
const action = (t, l) => { if (!inWin(t)) return; const i = idx(t); if (cls[i] !== 'M') cls[i] = 'A'; add(aLab, i, l); };
if (src.conductor) for (const [role, e, label] of src.conductor) if (role === 'user') action(+e, label);
if (src.slack) for (const [e, chan] of src.slack) action(+e, '#' + (chan || 'slack'));
if (src.git) for (const [e, label] of src.git) action(+e, label || 'commit');
// passe 3 : meetings — priorité la plus forte
if (src.calendar) for (const [sIso, eIso, title] of src.calendar) {
  const s = Date.parse(sIso) / 1000, e = Date.parse(eIso) / 1000;
  if (!(e > t0 && s < t1)) continue;
  for (let i = Math.max(0, idx(s)); i <= Math.min(N - 1, idx(e - 1)); i++) { cls[i] = 'M'; add(mLab, i, title); }
}

// blocs contigus de même type
const blocks = [];
for (let i = 0; i < N; i++) {
  if (cls[i] === '.') continue;
  const labs = cls[i] === 'M' ? mLab[i] : cls[i] === 'A' ? aLab[i] : wLab[i];
  const last = blocks[blocks.length - 1];
  if (last && last.c === cls[i] && last.end === i) { last.end = i + 1; for (const l of labs) if (!last.labs.includes(l)) last.labs.push(l); }
  else blocks.push({ c: cls[i], start: i, end: i + 1, labs: [...labs] });
}
const cnt = c => cls.filter(x => x === c).length;
const q = n => `${Math.floor(n * 15 / 60)}h${String((n * 15) % 60).padStart(2, '0')}`;
const fmtT = i => new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date((t0 + i * BUCKET) * 1000));
const TYPE = { A: 'Travail', M: 'Meeting', W: 'Attente Claude' };
const desc = b => { const s = b.labs.slice(0, 3).join(', ') || (b.c === 'A' ? 'activité' : ''); return s.length > 110 ? s.slice(0, 108) + '…' : s; };

if (!blocks.length) { console.log(`=== /heures ${date} ===\nAucune activité détectée sur la fenêtre 04:00 → 04:00.`); process.exit(0); }

// ---------- HTML ----------
const W = 1160, PL = 20, PR = 20, PT = 14, barH = 26, PB = 34, H = PT + barH + PB;
const dispS = Math.floor((t0 + blocks[0].start * BUCKET) / 3600) * 3600;
const dispE = Math.ceil((t0 + blocks[blocks.length - 1].end * BUCKET) / 1800) * 1800;
const X = t => PL + (t - dispS) / (dispE - dispS) * (W - PL - PR);
const step = (dispE - dispS) > 12 * 3600 ? 7200 : 3600;
const fmtE = t => new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(t * 1000));
let grid = '', ticks = '';
for (let t = Math.ceil(dispS / step) * step; t <= dispE; t += step) {
  grid += `<line x1="${X(t).toFixed(1)}" y1="${PT}" x2="${X(t).toFixed(1)}" y2="${PT + barH}" class="grid"/>`;
  ticks += `<text x="${X(t).toFixed(1)}" y="${PT + barH + 18}" class="tick" text-anchor="middle">${fmtE(t)}</text>`;
}
const rects = blocks.map(b => {
  const x = X(t0 + b.start * BUCKET), w = Math.max(X(t0 + b.end * BUCKET) - x - 1, 3);
  const fill = b.c === 'W' ? 'url(#hatchW)' : b.c === 'M' ? 'var(--series-3)' : 'var(--series-1)';
  const tip = `${TYPE[b.c]} · ${fmtT(b.start)} – ${fmtT(b.end)} · ${q(b.end - b.start)}${desc(b) ? ' · ' + desc(b) : ''}`;
  return `<rect x="${x.toFixed(1)}" y="${PT + 3}" width="${w.toFixed(1)}" height="${barH - 6}" rx="4" fill="${fill}" data-tip="${tip.replace(/"/g, '&quot;')}"/>`;
}).join('\n');
const tableRows = blocks.map(b =>
  `<tr><td><span class="chip ${b.c}"></span>${TYPE[b.c]}</td><td>${fmtT(b.start)} – ${fmtT(b.end)}</td><td>${q(b.end - b.start)}</td><td>${desc(b)}</td></tr>`).join('\n');
const sourcesLine = Object.entries(src).map(([k, v]) => `${k} ${v ? '✓' : '✗'}`).join(' · ');
const jour = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`));

const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Heures — ${date}</title>
<style>
.viz-root{color-scheme:light;--surface-1:#fcfcfb;--page:#f9f9f7;--text-primary:#0b0b0b;--text-secondary:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--border:rgba(11,11,11,.10);--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a}
@media (prefers-color-scheme: dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--surface-1:#1a1a19;--page:#0d0d0d;--text-primary:#fff;--text-secondary:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--surface-1:#1a1a19;--page:#0d0d0d;--text-primary:#fff;--text-secondary:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.viz-root{background:var(--page);min-height:100vh;padding:32px;box-sizing:border-box;color:var(--text-primary)}
.card{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:1240px;margin:0 auto}
h1{font-size:17px;margin:0 0 2px}.sub{color:var(--text-secondary);font-size:13px;margin:0 0 20px}
.tiles{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.tile{border:1px solid var(--border);border-radius:10px;padding:12px 16px;min-width:150px}
.tile .v{font-size:26px;font-weight:650}.tile .l{font-size:12px;color:var(--text-secondary);margin-top:2px}
.legend{display:flex;gap:18px;font-size:13px;color:var(--text-secondary);margin:0 0 8px;align-items:center}
.legend i{width:12px;height:12px;border-radius:3px;display:inline-block;margin-right:6px;vertical-align:-1px}
.chip{width:10px;height:10px;border-radius:3px;display:inline-block;margin-right:7px}
.A{background:var(--series-1)}.M{background:var(--series-3)}
.W{background:repeating-linear-gradient(45deg,var(--series-2) 0 2px,transparent 2px 6px)}
svg{width:100%;height:auto;display:block}
.grid{stroke:var(--grid);stroke-width:1}
.tick{fill:var(--muted);font-size:11px;font-family:system-ui,sans-serif;font-variant-numeric:tabular-nums}
rect[data-tip]:hover{stroke:var(--text-primary);stroke-width:1.5}
#tip{position:fixed;pointer-events:none;background:var(--surface-1);color:var(--text-primary);border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:12.5px;box-shadow:0 4px 14px rgba(0,0,0,.18);display:none;z-index:9;max-width:520px}
table{border-collapse:collapse;margin-top:16px;font-variant-numeric:tabular-nums;width:100%}
td,th{padding:6px 14px 6px 0;text-align:left;border-bottom:1px solid var(--grid);font-size:13px;vertical-align:top}
th{color:var(--muted);font-weight:500}
.note{color:var(--muted);font-size:12px;margin-top:14px;line-height:1.5}
</style></head><body><div class="viz-root"><div class="card">
<h1>Heures de travail — ${jour}</h1>
<p class="sub">Tranches de 15 min · Conductor + Slack + Calendar + Git · heures ${TZ}</p>
<div class="tiles">
<div class="tile"><div class="v">${q(cnt('A') + cnt('M'))}</div><div class="l">Travail (dont meetings ${q(cnt('M'))})</div></div>
<div class="tile"><div class="v">${q(cnt('W'))}</div><div class="l">En attente de Claude</div></div>
<div class="tile"><div class="v">${fmtT(blocks[0].start)} → ${fmtT(blocks[blocks.length - 1].end)}</div><div class="l">Amplitude</div></div>
</div>
<div class="legend"><span><i class="A"></i>Travail actif</span><span><i class="M"></i>Meeting</span><span><i class="W"></i>En attente de Claude (hachuré)</span></div>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Frise des heures de travail du ${date}">
<defs><pattern id="hatchW" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
<rect width="6" height="6" fill="var(--series-2)" opacity="0.28"/><line x1="1" y1="0" x2="1" y2="6" stroke="var(--series-2)" stroke-width="2"/></pattern></defs>
${grid}
<line x1="${PL}" y1="${PT + barH}" x2="${W - PR}" y2="${PT + barH}" stroke="var(--axis)"/>
${rects}
${ticks}
</svg>
<table><tr><th>Type</th><th>Plage</th><th>Durée</th><th>Description</th></tr>
${tableRows}</table>
<p class="note">Méthode déterministe : toute tranche de 15 min contenant au moins une action de toi (message Conductor, message Slack, commit manuel) compte en entier comme travail ; un meeting accepté compte sur toute sa durée. « En attente de Claude » = les agents tournent mais aucun input de toi — affiché hachuré, non compté dans le total travail. Sources : ${sourcesLine}.</p>
<div id="tip"></div>
</div></div>
<script>
const tip=document.getElementById('tip');
document.querySelectorAll('rect[data-tip]').forEach(r=>{
 r.addEventListener('mousemove',e=>{tip.textContent=r.dataset.tip;tip.style.display='block';
  tip.style.left=Math.min(e.clientX+14,innerWidth-tip.offsetWidth-8)+'px';tip.style.top=(e.clientY+14)+'px';});
 r.addEventListener('mouseleave',()=>tip.style.display='none');});
</script></body></html>`;
writeFileSync(`${dir}/heures.html`, html);

// ---------- récap terminal (à recopier tel quel) ----------
const out = [];
out.push(`=== /heures ${date} (${jour}) ===`);
out.push(`Travail : ${q(cnt('A') + cnt('M'))} (dont meetings ${q(cnt('M'))}) · En attente de Claude : ${q(cnt('W'))} · Amplitude ${fmtT(blocks[0].start)} → ${fmtT(blocks[blocks.length - 1].end)}`);
for (const b of blocks) out.push(`${fmtT(b.start)}–${fmtT(b.end)}  ${TYPE[b.c].padEnd(14)} ${desc(b)}`);
out.push(`Sources : ${sourcesLine}`);
out.push(`HTML : ${dir}/heures.html`);
console.log(out.join('\n'));
