const KEY = 'london-quiz:v1';

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
}

let state = read();
state.stats ??= {};
state.bests ??= {};

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private mode or full storage: progress just won't persist.
  }
}

/** Per-mode record of how well you've done on each item. */
export function statsFor(mode) {
  return (state.stats[mode] ??= {});
}

export function record(mode, id, points, km) {
  const s = (statsFor(mode)[id] ??= { n: 0, best: 0, last: 0, total: 0, km: 0 });
  s.n += 1;
  s.best = Math.max(s.best, points);
  s.last = points;
  s.total += points;
  s.km = km;
  s.at = Date.now();
  save();
}

export function bestScore(key) {
  return state.bests[key] ?? null;
}

/** Returns true if this is a new personal best. */
export function submitScore(key, score) {
  if (score > (state.bests[key] ?? -1)) {
    state.bests[key] = score;
    save();
    return true;
  }
  return false;
}

export function resetProgress() {
  state = { stats: {}, bests: {} };
  save();
}

/** Bucket an item by how well you know it, from its most recent attempts. */
export function mastery(s) {
  if (!s) return 'unseen';
  const score = (s.best + 2 * s.last) / 3;
  if (score >= 750) return 'known';
  if (score >= 500) return 'shaky';
  return 'lost';
}
