import { distanceKm, bearing, compass, pointInGeometry, nearestOnGeometry, centroid } from './geo.js';

export const MAX_POINTS = 1000;
export const STOPS = 10;

/**
 * Question types. `perfect` is the radius that still earns full marks (an area is
 * big, a station is a dot); `scale` is how quickly points fall away beyond it.
 */
export const KINDS = {
  places: { noun: 'neighbourhood', perfect: 0.4, scale: 2.0 },
  stations: { noun: 'tube station', perfect: 0.2, scale: 1.5 },
  landmarks: { noun: 'landmark', perfect: 0.2, scale: 1.5 },
  boroughs: { noun: 'borough', perfect: 0, scale: 1.5 },
};

/** Every game rides from the famous centre out to cabbie territory. */
const TIER_BY_STOP = [1, 1, 1, 2, 2, 2, 2, 3, 3, 3];
const KIND_MIX = ['places', 'places', 'places', 'places', 'places', 'landmarks', 'landmarks', 'stations', 'stations', 'boroughs'];
/** Stops where a place you previously missed can come back. */
const REVISIT_STOPS = [3, 5, 8];
export const MISSED_BELOW = 500;
/** How long a place you've been asked stays out of new games, missed or not. */
const REST = 12 * 3600e3;

export function pointsFor(km, kind, hinted = false) {
  const { perfect, scale } = KINDS[kind];
  const raw = km <= perfect ? MAX_POINTS : MAX_POINTS * Math.exp(-(km - perfect) / scale);
  return Math.round(hinted ? raw / 2 : raw);
}

/**
 * Score a guess. For point targets it's straight-line distance; for boroughs a
 * click anywhere inside counts as exact, otherwise distance to the nearest edge.
 */
export function judge(target, guess, kind, hinted = false) {
  if (kind === 'boroughs') {
    const inside = pointInGeometry(guess, target.geometry);
    const edge = inside ? { km: 0, lat: guess.lat, lng: guess.lng } : nearestOnGeometry(guess, target.geometry);
    return {
      km: edge.km,
      points: pointsFor(edge.km, kind, hinted),
      inside,
      nearest: { lat: edge.lat, lng: edge.lng },
      direction: inside ? null : compass(bearing(guess, centroid(target.geometry))),
    };
  }
  const km = distanceKm(guess, target);
  return {
    km,
    points: pointsFor(km, kind, hinted),
    inside: km <= KINDS[kind].perfect,
    nearest: { lat: target.lat, lng: target.lng },
    direction: compass(bearing(guess, target)),
  };
}

export function verdict(points) {
  if (points >= 950) return 'Spot on';
  if (points >= 750) return 'Very close';
  if (points >= 500) return 'Close';
  if (points >= 250) return 'Not far off';
  if (points >= 80) return 'A way off';
  return 'Miles off';
}

export function gameVerdict(total) {
  const avg = total / STOPS;
  if (avg >= 900) return 'You could sit the Knowledge.';
  if (avg >= 750) return 'A proper Londoner.';
  if (avg >= 550) return 'You know your way around.';
  if (avg >= 350) return 'Getting there.';
  return 'Time to get an A–Z.';
}

/**
 * Blue, amber or red: how a stop is coloured everywhere once played. Red is
 * exactly the set of stops that will come back in a later game.
 */
export function grade(points) {
  if (points >= 750) return 'good';
  if (points >= MISSED_BELOW) return 'ok';
  return 'poor';
}

export const isMissed = (s) => s && s.last < MISSED_BELOW;

function shuffle(list, random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Southwark the neighbourhood and Southwark the borough count as the same answer. */
const nameOf = (item) => item.name.toLowerCase();

/** When each name was last asked, whichever kind of question it was asked as. */
function lastAsked(pools, stats) {
  const asked = new Map();
  for (const [kind, byId] of Object.entries(stats)) {
    for (const item of pools[kind] ?? []) {
      const at = byId[item.id]?.at;
      if (at > (asked.get(nameOf(item)) ?? -Infinity)) asked.set(nameOf(item), at);
    }
  }
  return asked;
}

/**
 * Weighted draw of one item. Unseen and badly-guessed items come up more. Anything
 * still resting is left out, unless the whole pool is, when the stalest item goes.
 */
function draw(pool, stats, taken, { now, random, asked }) {
  const options = pool.filter((it) => !taken.has(nameOf(it)));
  if (!options.length) return null;
  const askedAt = (it) => asked.get(nameOf(it)) ?? -Infinity;
  const rested = options.filter((it) => now - askedAt(it) >= REST);
  if (!rested.length) return options.reduce((a, b) => (askedAt(b) < askedAt(a) ? b : a));
  const weights = rested.map((it) => {
    const s = stats[it.id];
    return s ? 0.3 + 2.5 * (1 - s.last / MAX_POINTS) : 1.5;
  });
  let r = random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < rested.length; i++) {
    if ((r -= weights[i]) <= 0) return rested[i];
  }
  return rested[rested.length - 1];
}

/**
 * Build one game: ten stops of rising difficulty, mostly neighbourhoods with a few
 * landmarks, stations and a borough. Up to three places you previously missed are
 * slotted back in so they get another go, once they've had a rest.
 *
 * `pools` maps kind -> items (each with id and tier); `stats` maps kind -> id -> record.
 */
export function buildGame(pools, stats = {}, { now = Date.now(), random = Math.random } = {}) {
  const kinds = shuffle(KIND_MIX, random);
  const taken = new Set();
  const asked = lastAsked(pools, stats);
  const stops = new Array(STOPS).fill(null);

  const missed = shuffle(
    Object.entries(stats).flatMap(([kind, byId]) =>
      Object.entries(byId)
        .filter(([, s]) => isMissed(s))
        .map(([id]) => ({ kind, item: pools[kind]?.find((it) => it.id === id) }))
        .filter((m) => m.item && now - asked.get(nameOf(m.item)) >= REST)),
    random,
  );
  for (const at of REVISIT_STOPS) {
    const m = missed.find((c) => !taken.has(nameOf(c.item)));
    if (!m) break;
    stops[at] = { kind: m.kind, item: m.item, revisit: true };
    taken.add(nameOf(m.item));
  }

  for (let i = 0; i < STOPS; i++) {
    if (stops[i]) continue;
    const kind = kinds[i];
    const tier = TIER_BY_STOP[i];
    const pool = pools[kind];
    // Use the hardest tier this kind has, up to the stop's difficulty (boroughs stop at 2).
    const top = Math.max(...pool.filter((it) => it.tier <= tier).map((it) => it.tier));
    const item = draw(pool.filter((it) => it.tier === top), stats[kind] ?? {}, taken, { now, random, asked })
      ?? draw(pool, {}, taken, { now, random, asked });
    taken.add(nameOf(item));
    stops[i] = { kind, item, revisit: false };
  }
  return stops;
}
