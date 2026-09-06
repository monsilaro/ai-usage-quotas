const $ = id => document.getElementById(id);
let quotaCards = [];
const token = new URLSearchParams(location.search).get('token');
const names = { codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini CLI', grok: 'Grok Build', opencode: 'OpenCode', cursor: 'Cursor' };
const statuses = { connected: 'Connecté', imported: 'Importé', empty: 'Aucun compteur', 'not-found': 'Non trouvé', 'import-required': 'Import CSV', partial: 'Couverture partielle' };
const palette = ['#b8ecc7', '#7fb8e6', '#e6bc77', '#c9a7f0', '#f09a9a', '#8fd6d0', '#d3d98a'];
const OTHER = '__other';
let data, period = '7', metric = 'cost', group = 'model', filtered = [], sortKey = null, sortDir = -1;
const nf = new Intl.NumberFormat('fr-CA', { notation: 'compact', maximumFractionDigits: 2 });
const currency = () => data?.exchange?.currency || 'CAD';
const multiplier = () => data?.exchange?.rate || 1;
const cadValue = n => (n || 0) * multiplier();
const fmt = n => nf.format(n || 0);
const dollars = n => new Intl.NumberFormat('fr-CA', { style: 'currency', currency: currency(), currencyDisplay: 'narrowSymbol', maximumFractionDigits: 2 }).format(cadValue(n));
const unitRate = n => new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 6 }).format(cadValue(n));
const dayKey = time => { const d = new Date(time); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const niceDate = time => new Date(time).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' });
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = kind => { const id = names[kind] || kind === 'day' ? kind : 'generic'; return `<span class="tool-icon" aria-hidden="true"><svg><use href="#icon-${id}"/></svg></span>`; };
const metricValue = e => metric === 'cost' ? (e.cost || 0) : e.total;
const metricFmt = v => metric === 'cost' ? dollars(v) : fmt(v);
async function api(route, body) {
  const response = await fetch(`/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-AI-Usage-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Erreur de chargement.'); return value;
}
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 5000); }
function options(id, values, label) {
  const selected = $(id).value;
  $(id).replaceChildren(new Option(label, 'all'), ...values.map(([value, text]) => new Option(text, value)));
  $(id).value = values.some(([v]) => v === selected) ? selected : 'all';
}
function accept(value) {
  data = value;
  document.body.classList.remove('loading');
  $('cost-currency').textContent = currency();
  $('price-currency').textContent = `${currency()} PAR MILLION DE TOKENS`;
  const fx = data.exchange;
  const fxText = fx?.rate ? `CAD · 1 USD = ${fx.rate.toFixed(4)} CAD · Banque du Canada, ${fx.date} · taux du jour appliqué à la période` : 'USD temporairement · taux CAD indisponible';
  $('exchange-note').textContent = fxText;
  $('exchange-status').textContent = fxText;
  options('tool', [...new Set(data.events.map(e => e.tool))].sort().map(t => [t, names[t] || t]), 'Tous les outils');
  options('model', [...new Set(data.events.map(e => e.model))].sort().map(t => [t, t]), 'Tous les modèles');
  options('project', [...new Set(data.events.map(e => e.project))].sort().map(t => [t, t.split(/[/\\]/).filter(Boolean).at(-1) || t]), 'Tous les projets');
  renderSources(); renderPrices(); render();
}
function sum(events) {
  const result = { input: 0, cached: 0, write: 0, output: 0, total: 0, cost: 0, savings: 0, unpriced: 0, priced: 0, sessions: new Set() };
  for (const e of events) {
    for (const k of ['input', 'cached', 'write', 'output', 'total']) result[k] += e[k];
    if (e.cost === null) result.unpriced += e.total; else { result.cost += e.cost; result.priced++; }
    result.savings += e.savings || 0; if (e.sessionKnown !== false) result.sessions.add(e.session);
  }
  return result;
}
function bounds() {
  const end = Date.now(); let start;
  if (period === 'all') start = data.events[0]?.time || end;
  else if (period === '1') start = end - 86400000;
  else { const d = new Date(end); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - Number(period) + 1); start = +d; }
  return { start, end };
}
// Time buckets covering the period: hourly for 24 h, daily otherwise.
function timeBuckets(start, end) {
  const hourly = period === '1';
  const key = t => hourly ? Math.floor(t / 3600000) : dayKey(t);
  const buckets = new Map();
  const cursor = new Date(start); if (hourly) cursor.setMinutes(0, 0, 0); else cursor.setHours(0, 0, 0, 0);
  while (+cursor <= end && buckets.size < 10000) {
    buckets.set(key(+cursor), { time: +cursor, events: [] });
    if (hourly) cursor.setHours(cursor.getHours() + 1); else cursor.setDate(cursor.getDate() + 1);
  }
  return { hourly, key, buckets };
}
function render() {
  if (!data) return;
  const { start, end } = bounds();
  const inPeriod = data.events.filter(e => e.time >= start && e.time <= end);
  filtered = inPeriod.filter(e => ['tool', 'model', 'project'].every(k => $(k).value === 'all' || $(k).value === e[k]));
  const total = sum(filtered);
  $('hero-label').textContent = metric === 'cost' ? `COÛT API ESTIMÉ · ${currency()}` : 'TOKENS TRAITÉS';
  $('hero-number').textContent = metric === 'cost' ? (total.priced ? dollars(total.cost) : filtered.length ? 'Inconnu' : dollars(0)) : fmt(total.total);
  $('date-range').textContent = `${niceDate(start)} — ${niceDate(end)}${period === '1' ? ' · dernières 24 h' : ''}`;
  $('estimate-note').innerHTML = metric === 'cost' ? `Équivalent API en ${currency()}.<br>${total.unpriced ? 'Total partiel : certains tarifs sont inconnus.' : 'Ce montant n’est pas votre facture.'}` : 'Chaque appel peut relire le contexte.<br>Le cache est inclus dans les tokens.';
  $('session-total').textContent = `${total.sessions.size} sessions connues · ${filtered.length} relevés`;
  $('stat-total').textContent = fmt(total.total); $('stat-cache').textContent = fmt(total.cached); $('stat-input').textContent = fmt(total.input); $('stat-output').textContent = fmt(total.output);
  $('stat-savings').textContent = total.priced ? dollars(total.savings) : '—';
  const input = total.input + total.cached + total.write;
  $('cache-ratio').textContent = `${input ? (total.cached / input * 100).toFixed(1) : '0'} % des tokens entrants`;
  $('cache-write').textContent = `${fmt(total.write)} en écriture de cache`;
  renderNotice(total);
  $('breakdown-subtitle').textContent = `${filtered.length} relevés · ${[...new Set(filtered.map(e => e.model))].length} modèles · part calculée sur les tokens`;
  $('coverage').textContent = `${data.sources.filter(s => s.records > 0).length} sources avec des compteurs · ${total.unpriced ? 'Coût partiel' : 'Tarifs connus pour les relevés affichés'}`;
  $('updated').textContent = `Actualisé à ${new Date(data.generatedAt).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' })}`;
  renderSourceValues(inPeriod);
  renderChart(start, end); renderTable(total, start, end);
}
function renderNotice(total) {
  const items = [];
  if (total.unpriced) items.push({ text: `${fmt(total.unpriced)} tokens sans tarif connu · estimation partielle.`, action: 'Compléter les tarifs', open: 'prices-dialog' });
  if (data.exchange?.warning) items.push({ text: data.exchange.warning });
  if (data.pricing.warning) items.push({ text: data.pricing.warning });
  if (data.sources.some(s => s.status === 'partial')) items.push({ text: 'Certaines sources ont une couverture partielle.', action: 'Voir les sources', open: 'sources-dialog' });
  $('notice').innerHTML = items.map(item => `<div class="notice-item"><span class="notice-icon" aria-hidden="true">!</span><span class="notice-text">${esc(item.text)}</span>${item.open ? `<button class="notice-action" data-open="${item.open}">${item.action} →</button>` : ''}</div>`).join('');
  $('notice').hidden = !items.length;
  $('notice').querySelectorAll('[data-open]').forEach(b => b.onclick = () => $(b.dataset.open).showModal());
}
// Sidebar: per-tool value for the selected period and metric; clicking toggles the tool filter.
function renderSourceValues(inPeriod) {
  const active = $('tool').value;
  for (const item of $('source-list').querySelectorAll('[data-tool]')) {
    const events = inPeriod.filter(e => e.tool === item.dataset.tool);
    const t = sum(events);
    item.querySelector('.source-value').textContent = !events.length ? '' : metric === 'cost' ? (t.priced ? dollars(t.cost) : '?') : fmt(t.total);
    item.classList.toggle('active', active === item.dataset.tool);
    item.setAttribute('aria-pressed', String(active === item.dataset.tool));
  }
}
function renderTable(total, start, end) {
  const buckets = new Map();
  for (const e of filtered) { const key = group === 'day' ? dayKey(e.time) : e[group]; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(e); }
  const rows = [...buckets].map(([key, events]) => { const t = sum(events); return { key, events, ...t, sessionCount: t.sessions.size }; });
  const effectiveKey = sortKey || (group === 'day' ? 'key' : metric);
  const dir = sortKey ? sortDir : -1;
  rows.sort((a, b) => {
    if (effectiveKey === 'key') return a.key.localeCompare(b.key) * dir;
    const field = effectiveKey === 'sessions' ? 'sessionCount' : effectiveKey;
    return (a[field] - b[field]) * dir || a.key.localeCompare(b.key);
  });
  document.querySelectorAll('#breakdown-table th[data-sort]').forEach(th => {
    const on = th.dataset.sort === effectiveKey;
    th.classList.toggle('sorted', on);
    th.setAttribute('aria-sort', on ? (dir > 0 ? 'ascending' : 'descending') : 'none');
  });
  $('group-heading').textContent = { model: 'Modèle', tool: 'Outil', day: 'Jour' }[group];
  const { buckets: slots, key: slotKey } = timeBuckets(start, end);
  const slotKeys = [...slots.keys()];
  const showSpark = group !== 'day' && slotKeys.length > 1;
  $('breakdown-body').innerHTML = rows.length ? rows.map(r => {
    const share = total.total ? r.total / total.total * 100 : 0;
    const tools = [...new Set(r.events.map(e => e.tool))];
    const label = group === 'tool' ? names[r.key] || r.key : r.key;
    const fixButton = r.unpriced ? `<button class="text-button fix-price" data-model="${group === 'model' ? esc(r.key) : ''}">${r.priced ? 'Compléter' : 'Ajouter un tarif'}</button>` : '';
    const cost = r.priced ? dollars(r.cost) + (r.unpriced ? ' <span class="unknown">+ ?</span>' : '') : '<span class="unknown">Tarif inconnu</span>';
    return `<tr${r.unpriced ? ' class="unpriced"' : ''}><td><div class="model-cell">${icon(group === 'day' ? 'day' : tools[0])}<div><strong>${esc(label)}</strong><small>${tools.map(t => names[t] || t).join(' · ')}</small></div></div></td><td><div class="cost-cell">${cost}${fixButton}</div></td><td><div class="share-cell"><span class="share-track"><span style="width:${share}%"></span></span>${share.toFixed(1)} %</div></td><td>${fmt(r.total)}</td><td>${r.sessionCount || '—'}</td><td class="spark-cell">${showSpark ? sparkline(r.events, slotKeys, slotKey) : ''}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty">Aucun compteur pour ces filtres.<br><br>Essayez une autre période ou consultez les sources.</td></tr>';
  $('breakdown-body').querySelectorAll('.fix-price').forEach(b => b.onclick = () => openPriceFor(b.dataset.model));
}
function sparkline(events, slotKeys, slotKey) {
  const index = new Map(slotKeys.map((k, i) => [k, i]));
  const values = slotKeys.map(() => 0);
  for (const e of events) { const i = index.get(slotKey(e.time)); if (i !== undefined) values[i] += metricValue(e); }
  const max = Math.max(...values, 1e-9), w = 88, h = 24, pad = 2;
  const pts = values.map((v, i) => `${(pad + (w - pad * 2) * (i / (values.length - 1))).toFixed(1)},${(h - pad - (h - pad * 2) * v / max).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="M${pts.join(' L')} L${w - pad},${h} L${pad},${h} Z" fill="#b8ecc7" fill-opacity=".12"/><path d="M${pts.join(' L')}" fill="none" stroke="#8cba9a" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}
function openPriceFor(model) {
  $('prices-dialog').showModal();
  if (model) { $('price-model').value = model; $('price-model').dispatchEvent(new Event('change')); }
  $('price-form').scrollIntoView({ block: 'center' });
  $(model ? 'price-input' : 'price-model').focus();
}
function renderChart(start, end) {
  const { hourly, key: bucketKey, buckets } = timeBuckets(start, end);
  for (const e of filtered) buckets.get(bucketKey(e.time))?.events.push(e);
  // One line per model; the smallest ones collapse into "Autres".
  const totals = new Map();
  for (const e of filtered) totals.set(e.model, (totals.get(e.model) || 0) + metricValue(e));
  const order = [...totals].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const keys = order.slice(0, palette.length - 1);
  const otherTotal = order.slice(keys.length).reduce((s, k) => s + totals.get(k), 0);
  const series = order.length > keys.length ? [...keys, OTHER] : keys;
  const color = k => k === OTHER ? '#5a666c' : palette[keys.indexOf(k)];
  const label = k => k === OTHER ? 'Autres' : k;
  const seriesTotal = k => k === OTHER ? otherTotal : totals.get(k);
  const seriesKey = e => keys.includes(e.model) ? e.model : OTHER;
  const points = [...buckets.values()].map(b => {
    const per = Object.fromEntries(series.map(k => [k, 0]));
    for (const e of b.events) per[seriesKey(e)] += metricValue(e);
    return { ...b, ...sum(b.events), per };
  });
  const chart = $('chart');
  const w = Math.max(300, chart.clientWidth), h = Math.max(215, chart.clientHeight), left = 58, right = 14, top = 14, bottom = 30;
  const max = Math.max(...points.flatMap(p => series.map(k => p.per[k])), metric === 'cost' ? 1 : 100);
  const n = points.length;
  const x = i => left + (w - left - right) * (n === 1 ? .5 : i / (n - 1));
  const y = v => h - bottom - (h - top - bottom) * v / max;
  const current = points.findIndex(p => bucketKey(p.time) === bucketKey(Date.now()));
  const axisText = v => metric === 'cost' ? fmt(cadValue(v)) + ' $' : fmt(v);
  const grid = [0, .25, .5, .75, 1].map(f => `<line x1="${left}" y1="${y(max * f).toFixed(1)}" x2="${w - right}" y2="${y(max * f).toFixed(1)}" stroke="${f ? '#232a2e' : '#2e363a'}" stroke-dasharray="${f ? '3 5' : '0'}"/>${f === .25 || f === .75 ? '' : `<text x="${left - 10}" y="${(y(max * f) + 4).toFixed(1)}" text-anchor="end" fill="#687780" font-size="12">${axisText(max * f)}</text>`}`).join('');
  const segment = (k, from, to) => points.slice(from, to + 1).map((p, i) => `${i ? 'L' : 'M'}${x(from + i).toFixed(1)},${y(p.per[k]).toFixed(1)}`).join(' ');
  // Biggest series drawn first so smaller ones stay visible on top. The in-progress bucket is dashed.
  const lines = [...series].reverse().map(k => {
    const c = color(k), last = current > 0 ? current - 1 : n - 1;
    const area = k === series[0] && n > 1 ? `<path d="${segment(k, 0, n - 1)} L${x(n - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z" fill="${c}" fill-opacity=".08"/>` : '';
    const solid = `<path d="${segment(k, 0, last)}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
    const dashed = current > 0 ? `<path d="${segment(k, current - 1, current)}" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>` : '';
    const dots = n <= 14 ? points.map((p, i) => p.per[k] ? `<circle cx="${x(i).toFixed(1)}" cy="${y(p.per[k]).toFixed(1)}" r="3" fill="${c}"/>` : '').join('') : '';
    return area + solid + dashed + dots;
  }).join('');
  const step = Math.max(1, Math.ceil(n / (w < 600 ? 4 : 7)));
  const tickLabel = p => hourly ? new Date(p.time).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' }) : niceDate(p.time);
  const ticks = points.map((p, i) => (i % step === 0 && i < n - 1 - step / 2) || i === n - 1 ? `<text x="${x(i).toFixed(1)}" y="${h - 8}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" fill="${i === current ? '#b8ecc7' : '#75868c'}" font-size="12">${tickLabel(p)}</text>` : '').join('');
  const slot = n > 1 ? (w - left - right) / (n - 1) : w - left - right;
  const hits = points.map((p, i) => `<rect class="hit" data-index="${i}" x="${(x(i) - slot / 2).toFixed(1)}" y="${top}" width="${slot.toFixed(1)}" height="${h - bottom - top}" fill="transparent"/>`).join('');
  chart.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${grid}${lines}<line id="crosshair" y1="${top}" y2="${h - bottom}" stroke="#b8ecc7" stroke-opacity=".35" stroke-dasharray="3 3" visibility="hidden"/>${ticks}${hits}</svg><div id="chart-tip" class="chart-tip" hidden></div>${filtered.length ? '' : '<div class="chart-empty">Aucun relevé pour ces filtres.</div>'}`;
  $('chart-title').textContent = `${metric === 'cost' ? 'Coût' : 'Tokens'} ${hourly ? 'par heure' : 'par jour'} · par modèle${metric === 'cost' && points.some(p => p.unpriced) ? ' · partiel' : ''}`;
  $('chart-legend').innerHTML = series.map(k => `<span class="legend-item"><i style="background:${color(k)}"></i>${esc(label(k))}<b>${metricFmt(seriesTotal(k))}</b></span>`).join('')
    + (current >= 0 ? `<span class="legend-item legend-note"><i class="dashed"></i>${hourly ? 'Heure' : 'Journée'} en cours</span>` : '');
  const tip = $('chart-tip'), crosshair = chart.querySelector('#crosshair');
  chart.querySelectorAll('.hit').forEach(el => el.addEventListener('pointerenter', () => {
    const i = Number(el.dataset.index), p = points[i];
    const rows = series.filter(k => p.per[k]).map(k => `<div class="tip-row"><i style="background:${color(k)}"></i><span>${esc(label(k))}</span><b>${metricFmt(p.per[k])}</b></div>`).join('');
    const when = new Date(p.time).toLocaleString('fr-CA', hourly ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { weekday: 'long', day: 'numeric', month: 'long' });
    const headline = !p.events.length ? 'Aucun relevé' : metric === 'cost' ? (p.priced ? dollars(p.cost) : 'Coût inconnu') : `${fmt(p.total)} tokens`;
    tip.innerHTML = `<div class="tip-head">${esc(when)}${i === current ? ' <em>· en cours</em>' : ''}</div><div class="tip-total">${headline}${p.unpriced && metric === 'cost' && p.priced ? ' <span class="unknown">+ ?</span>' : ''}</div>${rows}${p.events.length ? `<div class="tip-foot">${metric === 'cost' ? fmt(p.total) + ' tokens · ' : ''}${p.sessions.size} sessions · ${p.events.length} relevés</div>` : ''}`;
    tip.hidden = false;
    crosshair.setAttribute('x1', x(i).toFixed(1)); crosshair.setAttribute('x2', x(i).toFixed(1)); crosshair.setAttribute('visibility', 'visible');
    const px = x(i) / w * chart.clientWidth;
    const flip = px > chart.clientWidth * 0.6;
    tip.style.left = flip ? 'auto' : `${px + 14}px`; tip.style.right = flip ? `${chart.clientWidth - px + 14}px` : 'auto';
    tip.style.top = `${Math.max(0, Math.min(chart.clientHeight - tip.offsetHeight - 8, y(Math.max(...series.map(k => p.per[k]))) - 10))}px`;
  }));
  chart.querySelector('svg').addEventListener('pointerleave', () => { tip.hidden = true; crosshair.setAttribute('visibility', 'hidden'); });
}
function renderSources() {
  $('source-count').textContent = data.sources.filter(s => s.records).length;
  const dot = s => `<span class="source-dot ${['connected', 'imported', 'partial'].includes(s.status) ? s.status : ''}"></span>`;
  $('source-list').innerHTML = data.sources.map(s => `<button class="source-item" data-tool="${esc(s.tool)}" aria-pressed="false" title="Filtrer sur ${esc(s.label)} · ${statuses[s.status]}">${icon(s.tool)}<span class="source-label">${esc(s.label)}</span><span class="source-value"></span>${dot(s)}</button>`).join('');
  $('source-list').querySelectorAll('[data-tool]').forEach(b => b.onclick = () => {
    $('tool').value = $('tool').value === b.dataset.tool ? 'all' : b.dataset.tool;
    render(); closeNav();
  });
  $('source-cards').innerHTML = data.sources.map(s => `<div class="source-card"><div class="source-card-header">${icon(s.tool)}${esc(s.label)}<span class="status">${dot(s)}${statuses[s.status]}</span></div><p>${s.files} fichiers · ${s.records} relevés${s.errors ? ` · ${s.errors} erreurs de lecture` : ''}${s.malformed ? ` · ${s.malformed} lignes non lisibles` : ''}</p>${s.unsupported ? '<p>Historique OpenCode récent au format session_message non pris en charge; les anciens messages sont inclus.</p>' : ''}${s.paths.map(p => `<code>${esc(p)}</code>`).join('<br>')}</div>`).join('');
  $('config-path').textContent = data.configFile;
}
function renderPrices() {
  const detected = data.detectedPrices || [];
  $('detected-price-note').textContent = `${detected.length} modèle(s) / outil(s) · ${currency()} par million de tokens · tarifs utilisés dans les estimations`;
  const priceSources = { custom: 'Personnalisé', catalog: 'LiteLLM', 'models.dev': 'models.dev', unknown: 'Inconnu' };
  $('detected-price-body').innerHTML = detected.length ? detected.map(item => `<tr${item.rates ? '' : ' class="unpriced"'}><td><div class="model-cell"><div><strong>${esc(item.model)}</strong><small>${esc(names[item.tool] || item.tool)}${item.provider ? ' · ' + esc(item.provider) : ''}</small></div></div></td>${['input', 'cached', 'write', 'output'].map(k => `<td>${item.rates ? unitRate(item.rates[k]) : '<span class="unknown">&mdash;</span>'}</td>`).join('')}<td${item.rates ? '' : ' class="unknown"'}>${priceSources[item.priceSource] || 'Inconnu'}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">Aucun modèle détecté dans les historiques.</td></tr>';
  $('catalog-status').textContent = `${data.pricing.models} identifiants · ${data.pricing.updatedAt ? 'catalogue du ' + niceDate(data.pricing.updatedAt) : 'catalogue indisponible'}`;
  const unknown = [...new Set(data.events.filter(e => e.cost === null).map(e => e.model))].sort();
  $('unknown-models').textContent = unknown.length ? `Tarifs inconnus : ${unknown.join(', ')}. Aucun montant ne sera inventé si les catalogues ne permettent pas de les identifier.` : 'Tous les modèles enregistrés ont un tarif connu.';
  $('unknown-models').classList.toggle('ok', !unknown.length);
  const automatic = [...new Set(data.events.filter(e => e.priceSource === 'models.dev').map(e => `${e.model} (${e.provider || e.tool})`))];
  $('automatic-prices').textContent = automatic.length ? `Complétés via models.dev : ${automatic.join(', ')}. Pour Z.AI Coding Plan, le tarif API Z.AI est utilisé.` : '';
  $('model-options').replaceChildren(...[...new Set(data.events.map(e => e.model))].sort().map(m => new Option(m, m)));
  $('custom-prices').innerHTML = Object.entries(data.customPrices).map(([model, rates]) => `<div class="custom-price"><div>${esc(model)}<small class="muted"> · entrée ${unitRate(rates.input)} / cache ${unitRate(rates.cached)} / écriture ${unitRate(rates.write)} / sortie ${unitRate(rates.output)} ${currency()}</small></div><button class="text-button" data-remove="${esc(model)}">Supprimer</button></div>`).join('');
  $('custom-prices').querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', async () => {
    try { const prices = { ...data.customPrices }; delete prices[button.dataset.remove]; accept(await api('prices', prices)); toast('Tarif personnalisé supprimé.'); } catch (e) { toast(e.message); }
  }));
}
async function busy(button, action) { button.disabled = true; try { await action(); } catch (e) { toast(e.message); } finally { button.disabled = false; } }
$('refresh').onclick = () => busy($('refresh'), async () => { accept(await api('refresh', {})); toast('Historiques actualisés.'); });
$('refresh-prices').onclick = () => busy($('refresh-prices'), async () => { accept(await api('prices/refresh', {})); toast('Catalogue actualisé.'); });
$('complete-prices').onclick = () => busy($('complete-prices'), async () => {
  $('complete-status').textContent = 'Recherche des tarifs et vérification des fournisseurs…';
  try {
    const result = await api('prices/complete', {}); accept(result.data);
    $('complete-status').textContent = `${result.resolved.length} modèle(s) complété(s)${result.resolved.length ? ' : ' + result.resolved.join(', ') : ''}. ${result.remaining.length ? 'Toujours inconnus : ' + result.remaining.join(', ') + '.' : 'Tous les tarifs sont disponibles.'}${result.data.pricing.warning ? ' ' + result.data.pricing.warning : ''}`;
  } catch (e) { $('complete-status').textContent = e.message; throw e; }
});
for (const [id, key] of [['periods', 'period'], ['metrics', 'metric'], ['groups', 'group']]) $(id).querySelectorAll('button').forEach(button => {
  button.addEventListener('click', () => {
    if (key === 'period') period = button.dataset.period;
    if (key === 'metric') { metric = button.dataset.metric; if (sortKey === 'cost' || sortKey === 'total') sortKey = null; }
    if (key === 'group') { group = button.dataset.group; sortKey = null; }
    $(id).querySelectorAll('button').forEach(b => { b.classList.toggle('selected', b === button); b.setAttribute('aria-pressed', String(b === button)); }); render();
  });
});
document.querySelectorAll('#breakdown-table th[data-sort]').forEach(th => th.querySelector('button').addEventListener('click', () => {
  const key = th.dataset.sort;
  if (sortKey === key) sortDir = -sortDir; else { sortKey = key; sortDir = key === 'key' ? 1 : -1; }
  render();
}));
for (const id of ['tool', 'model', 'project']) $(id).onchange = render;
for (const id of ['open-sources', 'footer-sources']) $(id).onclick = () => { $('sources-dialog').showModal(); closeNav(); };
for (const id of ['open-prices', 'footer-prices']) $(id).onclick = () => { $('prices-dialog').showModal(); closeNav(); };
$('overview').onclick = () => { window.scrollTo({ top: 0, behavior: 'smooth' }); closeNav(); };
document.querySelectorAll('.close-dialog').forEach(b => b.onclick = () => b.closest('dialog').close());
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
// Mobile navigation drawer.
function closeNav() { document.body.classList.remove('nav-open'); $('menu').setAttribute('aria-expanded', 'false'); }
$('menu').onclick = () => { const open = document.body.classList.toggle('nav-open'); $('menu').setAttribute('aria-expanded', String(open)); };
$('nav-backdrop').onclick = closeNav;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNav(); });
$('cursor-file').onchange = async event => {
  const file = event.target.files[0]; if (!file) return;
  $('import-status').textContent = 'Import…'; event.target.disabled = true;
  try { const r = await api('import/cursor', { csv: await file.text() }); accept(r.data); $('import-status').textContent = `${r.imported} nouveaux relevés · ${r.skipped} lignes ignorées`; }
  catch (e) { $('import-status').textContent = e.message; } finally { event.target.disabled = false; event.target.value = ''; }
};
$('price-model').onchange = () => { const rates = data?.customPrices[$('price-model').value]; if (rates) for (const k of ['input', 'cached', 'write', 'output']) $(`price-${k}`).value = Number(cadValue(rates[k]).toFixed(8)); };
$('price-form').onsubmit = async event => {
  event.preventDefault();
  await busy(event.submitter, async () => {
    const rates = Object.fromEntries(['input', 'cached', 'write', 'output'].map(k => [k, Number($(`price-${k}`).value)]));
    accept(await api('prices/model', { model: $('price-model').value.trim(), rates, currency: currency(), exchangeRate: data.exchange?.rate })); $('price-status').textContent = 'Tarif enregistré.';
  });
};
$('export').onclick = () => {
  if (!data) return;
  const columns = ['tool', 'model', 'day', 'input', 'cached', 'write', 'output', 'total', 'estimated_cad', 'estimated_usd', 'usd_cad_rate', 'rate_date', 'unpriced_tokens'];
  const buckets = new Map();
  for (const e of filtered) { const key = JSON.stringify([e.tool, e.model, dayKey(e.time)]); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(e); }
  const safe = value => { let text = String(value); if (/^[=+@\-]/.test(text)) text = "'" + text; return '"' + text.replaceAll('"', '""') + '"'; };
  const rows = [...buckets].map(([key, events]) => { const t = sum(events); return [...JSON.parse(key), t.input, t.cached, t.write, t.output, t.total, t.priced && data.exchange?.rate ? cadValue(t.cost).toFixed(6) : '', t.priced ? t.cost.toFixed(6) : '', data.exchange?.rate || '', data.exchange?.date || '', t.unpriced].map(safe).join(','); });
  const url = URL.createObjectURL(new Blob(['﻿' + columns.join(',') + '\r\n' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `ai-usage-${dayKey(Date.now())}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
api('data').then(accept).catch(e => {
  document.body.classList.remove('loading');
  $('notice').hidden = false; $('notice').innerHTML = `<div class="notice-item"><span class="notice-icon" aria-hidden="true">!</span><span class="notice-text">${esc(e.message)}</span></div>`;
  $('chart').textContent = 'Chargement impossible. Utilisez Actualiser pour réessayer.'; $('hero-number').textContent = '—';
});
function quotaResetLabel(resetsAt, now) {
  if (resetsAt === null) return 'Reset non communiqué';
  const remaining = resetsAt - now;
  if (remaining <= 0) return 'Reset prévu passé · actualiser';
  const minutes = Math.floor(remaining / 60000);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  const duration = days ? `${days} j${hours ? ` ${hours} h` : ''}` : hours ? `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : minutes ? `${minutes} min` : 'moins d’une minute';
  return `Reset dans ${duration}`;
}
function renderQuotas() {
  const now = Date.now();
  const date = value => new Date(value).toLocaleString('fr-CA', { dateStyle: 'short', timeStyle: 'short' });
  const percent = value => new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 1 }).format(value);
  $('quota-cards').innerHTML = quotaCards.map(card => {
    const stale = card.status !== 'available' || (card.observedAt && now - card.observedAt > 15 * 60000);
    const rank = w => w.label === 'Semaine' ? 0 : w.minutes === 10080 ? 1 : 2;
    const windows = [...card.windows].sort((a, b) => rank(a) - rank(b));
    return `<article class="quota-card"><div class="quota-card-title">${icon(card.id)}<h3>${esc(card.name)}</h3><span class="quota-badge">${windows.length ? stale ? 'Ancien relevé' : 'Relevé disponible' : 'Indisponible'}</span></div>${windows.map((w, index) => {
      const expired = w.resetsAt !== null && w.resetsAt <= now;
      const remaining = Math.max(0, 100 - w.usedPercent);
      return `${index === 1 ? `<details class="quota-more"><summary>Autres limites (${windows.length - 1})</summary>` : ''}<div class="quota-window${expired || stale ? ' quota-stale' : ''}"><div class="quota-line"><span>${esc(w.label)}</span><strong>${expired ? 'À actualiser' : `${percent(w.usedPercent)} % utilisés`}</strong></div>${expired ? '<p class="small muted">La réinitialisation prévue est passée. Un nouveau relevé est nécessaire.</p>' : `<progress max="100" value="${Math.min(100, w.usedPercent)}" aria-label="${esc(card.name + ' · ' + w.label)}"></progress><div class="small muted">${percent(remaining)} % restants${stale ? ' au dernier relevé' : ''}</div>`}<div class="quota-reset${expired ? ' quota-reset-expired' : ''}">${quotaResetLabel(w.resetsAt, now)}</div><div class="small muted">${w.resetsAt ? `Réinitialisation : ${date(w.resetsAt)}` : 'Réinitialisation non fournie'}</div></div>${index > 0 && index === windows.length - 1 ? '</details>' : ''}`;
    }).join('')}${card.message ? `<p class="quota-message">${esc(card.message)}</p>` : ''}<div class="quota-meta small muted">${esc(card.source)}${card.observedAt ? `<br>Relevé : ${date(card.observedAt)}` : ''}</div><div class="quota-actions">${card.id === 'grok' ? '<button id="refresh-grok" class="subtle">↻ Actualiser Grok</button>' : ''}<a href="${esc(card.url)}" target="_blank" rel="noreferrer">Voir mon forfait ↗</a></div></article>`;
  }).join('');

}
async function refreshQuotas() {
  try {
    const result = await api('quotas'); quotaCards = result.cards; renderQuotas();
  } catch (error) { $('quota-status').textContent = error.message; }
}
$('quota-cards').addEventListener('click', event => {
  const button = event.target.closest('#refresh-grok');
  if (!button) return;
  busy(button, async () => {
    button.textContent = 'Actualisation…';
    $('quota-status').textContent = 'Actualisation de Grok en arrière-plan…';
    try { const result = await api('quotas/grok/refresh', {}); quotaCards = result.cards; renderQuotas(); $('quota-status').textContent = 'Quota Grok actualisé.'; }
    catch (error) { $('quota-status').textContent = error.message; throw error; }
    finally { button.textContent = '↻ Actualiser Grok'; }
  });
});
$('refresh-quotas').onclick = event => busy(event.currentTarget, refreshQuotas);
refreshQuotas();
setInterval(() => { if (!document.hidden) { renderQuotas(); refreshQuotas(); } }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshQuotas(); });
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (data) { const { start, end } = bounds(); renderChart(start, end); } }, 80); });
