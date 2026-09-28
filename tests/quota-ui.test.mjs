import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const script = await fs.readFile(new URL('../web/app.js', import.meta.url), 'utf8');
function elements() {
  const nodes = new Map();
  return id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, innerHTML: '', textContent: '', attrs: {}, classList: { toggle() {} },
      setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; },
      querySelectorAll: () => [{ dataset: { provider: 'claude' } }] });
    return nodes.get(id);
  };
}

test('provider rows show both main windows, separate missing accounts and never reset expired usage to zero', () => {
  const source = script.slice(script.indexOf('function quotaResetLabel('), script.indexOf('async function refreshQuotas('));
  const $ = elements(), now = Date.now();
  const context = vm.createContext({ $, Date, Intl, icon: () => '', grokRefreshing: false,
    esc: x => String(x).replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    quotaCards: [
      { id: 'claude', name: '<script>test</script>', url: 'https://claude.ai', source: 'local', status: 'available', observedAt: now - 3600000,
        windows: [{ label: 'Semaine', usedPercent: 12, resetsAt: now + 86400000 }, { label: '5 heures', usedPercent: 90, resetsAt: now + 3600000 }] },
      { id: 'codex', name: 'Codex', url: 'https://chatgpt.com', source: 'account', status: 'available', observedAt: now,
        windows: [{ label: 'Semaine', usedPercent: 100, resetsAt: now - 1000 }] },
      { id: 'opencode', name: 'OpenCode Go', url: 'https://opencode.ai', source: 'account', status: 'unavailable', observedAt: null, windows: [] }
    ]
  });
  vm.runInContext(source + '\nrenderQuotas();', context);
  const html = $('quota-cards').innerHTML;
  assert.ok(!html.includes('<script>'));
  assert.match(html, /data-provider="claude" open/);
  assert.match(html, /Au dernier relevé/);
  assert.match(html, /Relevé expiré/);
  assert.ok(html.indexOf('5 heures') < html.indexOf('Semaine'));
  assert.ok(html.indexOf('Semaine') < html.indexOf('<details'));
  assert.equal((html.match(/<progress /g) || []).length, 2);
  assert.ok(!html.includes('OpenCode Go'));
  assert.match($('quota-unavailable-cards').innerHTML, /OpenCode Go/);
  assert.equal($('quota-unavailable').hidden, false);
  assert.equal($('quota-summary').textContent, '0 fournisseur(s) à jour · 2 à actualiser');
});

test('navigation isolates costs, defers quota requests and restores the chart when returning', () => {
  const $ = elements(); let reads = 0, charts = 0, scrolls = 0;
  const location = { hash: '' };
  const context = vm.createContext({ $, activeView: 'usage', location, data: { events: [] },
    history: { pushState(_, __, hash) { location.hash = hash; } }, window: { scrollTo() { scrolls++; } }, closeNav() {}, renderQuotas() {},
    refreshQuotas() { reads++; }, bounds: () => ({ start: 1, end: 2 }), renderChart() { charts++; }
  });
  const source = script.slice(script.indexOf('function showView('), script.indexOf("$('brand-home').onclick"));
  vm.runInContext(source + "\nshowView('usage', false);", context);
  assert.equal(reads, 0); assert.equal($('plans-view').hidden, true); assert.equal($('usage-view').hidden, false);
  vm.runInContext("showView('plans');", context);
  assert.equal(location.hash, '#forfaits'); assert.equal(reads, 1);
  assert.equal($('usage-view').hidden, true); assert.equal($('plans-view').hidden, false);
  assert.equal($('tool-navigation').hidden, true); assert.equal($('plans-nav').attrs['aria-current'], 'page');
  vm.runInContext("showView('usage');", context);
  assert.equal(location.hash, '#couts'); assert.equal(reads, 1); assert.equal(charts, 2); assert.equal(scrolls, 2);
  assert.equal($('tool-navigation').hidden, false); assert.equal($('overview').attrs['aria-current'], 'page');
});
