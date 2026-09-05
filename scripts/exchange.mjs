import fsp from 'node:fs/promises';
import path from 'node:path';

export const FX_URL = 'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1';
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
export function parseExchange(raw) {
  const observations = (raw?.observations || []).filter(o => /^\d{4}-\d{2}-\d{2}$/.test(o.d) && positive(Number(o.FXUSDCAD?.v)));
  observations.sort((a, b) => b.d.localeCompare(a.d));
  if (!observations.length) throw new Error('Taux USD/CAD indisponible.');
  return { rate: Number(observations[0].FXUSDCAD.v), date: observations[0].d };
}
export async function loadExchange(dataDir, force = false, fetcher = fetch) {
  const file = path.join(dataDir, 'exchange.json'); let saved;
  try { saved = JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
  if (!positive(saved?.rate) || !/^\d{4}-\d{2}-\d{2}$/.test(saved?.date)) saved = null;
  let warning = '';
  if (force || !saved || Date.now() - (saved.fetchedAt || 0) > 86400000) {
    try {
      const response = await fetcher(FX_URL, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Exchange download failed');
      saved = { ...parseExchange(await response.json()), fetchedAt: Date.now() };
      await fsp.writeFile(file, JSON.stringify(saved));
    } catch { warning = saved ? 'Conversion CAD : dernier taux sauvegardé utilisé (hors ligne).' : 'Taux CAD indisponible : les montants restent temporairement en USD.'; }
  }
  return { rate: saved?.rate || null, date: saved?.date || null, source: FX_URL, warning, currency: saved ? 'CAD' : 'USD' };
}
export function ratesToUsd(rates, currency, exchange, submittedRate) {
  if (currency === 'USD') return rates;
  if (currency !== 'CAD' || !positive(exchange?.rate) || submittedRate !== exchange.rate) throw new Error('Le taux de conversion a changé ou est indisponible. Actualisez avant de sauvegarder.');
  return Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, v / exchange.rate]));
}
