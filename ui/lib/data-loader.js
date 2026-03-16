/** Canon Dashboard Data Loader — loads JSON from .canon/ directory */

const DATA_BASE = '../.canon';

export async function loadJSON(filename) {
  try {
    const resp = await fetch(`${DATA_BASE}/${filename}`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

export async function loadGraphData() {
  return loadJSON('graph-data.json');
}

export async function loadOrchestrationData() {
  return loadJSON('orchestration-data.json');
}

export async function loadPrinciplesData() {
  return loadJSON('principles-data.json');
}

export async function loadPrReviewData(prNumber) {
  return loadJSON(`pr-reviews/${prNumber}/review-data.json`);
}

export async function loadJsonl(filename) {
  try {
    const resp = await fetch(`${DATA_BASE}/${filename}`);
    if (!resp.ok) return [];
    const text = await resp.text();
    return text
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}
