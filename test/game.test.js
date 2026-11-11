import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { distanceKm, bearing, compass, pointInGeometry, nearestOnGeometry, formatKm } from '../src/geo.js';
import { pointsFor, judge, buildGame, verdict, MAX_POINTS, STOPS } from '../src/game.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url)));
const places = load('places.json');
const stations = load('stations.json');
const landmarks = load('landmarks.json');
const boroughs = load('boroughs.geojson').features;

const byName = (list, name) => list.find((x) => x.name === name);

test('distance matches known London distances', () => {
  const eye = byName(landmarks, 'London Eye');
  const pauls = byName(landmarks, "St Paul's Cathedral");
  // London Eye to St Paul's is about 1.9 km as the crow flies.
  assert.ok(Math.abs(distanceKm(eye, pauls) - 1.9) < 0.2, distanceKm(eye, pauls));
  assert.equal(distanceKm(eye, eye), 0);
});

test('bearings and compass points', () => {
  const o = { lat: 51.5, lng: -0.1 };
  assert.equal(compass(bearing(o, { lat: 51.6, lng: -0.1 })), 'north');
  assert.equal(compass(bearing(o, { lat: 51.5, lng: 0.1 })), 'east');
  assert.equal(compass(bearing(o, { lat: 51.4, lng: -0.1 })), 'south');
  assert.equal(compass(bearing(o, { lat: 51.45, lng: -0.18 })), 'south-west');
});

test('scoring rewards closeness and halves with a clue', () => {
  assert.equal(pointsFor(0, 'places'), MAX_POINTS);
  assert.equal(pointsFor(0.39, 'places'), MAX_POINTS);
  assert.ok(pointsFor(1, 'places') > pointsFor(3, 'places'));
  assert.ok(pointsFor(20, 'places') < 5);
  assert.equal(pointsFor(0, 'places', true), MAX_POINTS / 2);
  assert.equal(verdict(1000), 'Spot on');
  assert.equal(verdict(0), 'Miles off');
});

test('every place sits inside the borough it claims', () => {
  for (const list of [places, landmarks]) {
    for (const p of list) {
      const b = boroughs.find((f) => f.properties.name === p.borough);
      assert.ok(b, `${p.name} has unknown borough ${p.borough}`);
      const inside = pointInGeometry(p, b.geometry) || nearestOnGeometry(p, b.geometry).km < 0.4;
      assert.ok(inside, `${p.name} is not in ${p.borough}`);
    }
  }
});

test('well-known places are in the right boroughs', () => {
  const expect = {
    'Notting Hill': 'Kensington and Chelsea', Hackney: 'Hackney', Brixton: 'Lambeth', Soho: 'Westminster',
    Shoreditch: 'Hackney', Peckham: 'Southwark', Wimbledon: 'Merton', Stratford: 'Newham', Croydon: 'Croydon',
    'Canary Wharf': 'Tower Hamlets', Hampstead: 'Camden', Greenwich: 'Greenwich',
  };
  for (const [name, borough] of Object.entries(expect)) {
    assert.equal(byName(places, name)?.borough, borough, name);
  }
});

test('data sets have sensible sizes, unique ids and tiers', () => {
  for (const [list, min] of [[places, 400], [stations, 260], [landmarks, 100]]) {
    assert.ok(list.length >= min, `${list.length} < ${min}`);
    assert.equal(new Set(list.map((x) => x.id)).size, list.length, 'ids are unique');
    for (const x of list) {
      assert.ok([1, 2, 3].includes(x.tier), `${x.name} tier`);
      assert.ok(x.lat > 51.2 && x.lat < 51.75 && x.lng > -0.65 && x.lng < 0.35, `${x.name} is near London`);
    }
  }
  assert.equal(boroughs.length, 33);
  assert.equal(boroughs.filter((f) => f.properties.tier === 1).length, 13);
  assert.ok(places.filter((p) => p.tier === 1).length >= 100);
});

test('stations know their lines', () => {
  assert.deepEqual(byName(stations, 'Oxford Circus').lines, ['Bakerloo', 'Central', 'Victoria']);
  assert.ok(byName(stations, 'Battersea Power Station'), 'Northern line extension is included');
  assert.ok(!stations.some((s) => s.name.startsWith('Watford Vicarage')), 'never-built stations are excluded');
});

test('borough judging: inside scores full marks, outside measures to the edge', () => {
  const camden = boroughs.find((f) => f.properties.name === 'Camden');
  const target = { ...camden.properties, geometry: camden.geometry };
  const inside = judge(target, byName(places, 'Kentish Town'), 'boroughs');
  assert.equal(inside.inside, true);
  assert.equal(inside.points, MAX_POINTS);
  const outside = judge(target, byName(places, 'Brixton'), 'boroughs');
  assert.equal(outside.inside, false);
  assert.ok(outside.km > 3 && outside.km < 9, outside.km);
  assert.equal(outside.direction, 'north');
});

test('point judging gives direction from guess to answer', () => {
  const nh = byName(places, 'Notting Hill');
  const res = judge(nh, { lat: nh.lat + 0.02, lng: nh.lng }, 'places');
  assert.equal(res.direction, 'south');
  assert.ok(res.km > 2 && res.km < 2.4);
});

const pools = {
  places, stations, landmarks,
  boroughs: boroughs.map((f) => ({ ...f.properties, geometry: f.geometry })),
};

// Small seeded PRNG so the tests are repeatable.
function seeded(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

test('a game is ten distinct stops that get harder', () => {
  for (let seed = 1; seed < 40; seed++) {
    const game = buildGame(pools, {}, { random: seeded(seed) });
    assert.equal(game.length, STOPS);
    assert.equal(new Set(game.map((s) => `${s.kind}:${s.item.id}`)).size, STOPS);
    const counts = {};
    for (const s of game) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
    assert.deepEqual(counts, { places: 5, landmarks: 2, stations: 2, boroughs: 1 });
    // Opening stops are always famous; boroughs top out at tier 2.
    for (const s of game.slice(0, 3)) assert.equal(s.item.tier, 1);
    for (const s of game.slice(7)) assert.equal(s.item.tier, s.kind === 'boroughs' ? 2 : 3);
  }
});

test('places you missed come back, ones you nailed are rarer', () => {
  const now = Date.now();
  const hour = 3600e3;
  const brixton = places.find((p) => p.name === 'Brixton');
  const stats = { places: { [brixton.id]: { n: 1, best: 40, last: 40, at: now - 24 * hour } } };
  let back = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const game = buildGame(pools, stats, { now, random: seeded(seed) });
    const hit = game.find((s) => s.item.id === brixton.id);
    if (hit) { back++; assert.equal(hit.revisit, true); }
  }
  assert.equal(back, 20, 'a single missed place is always revisited');

  // Mark every tier-1 neighbourhood but one as known. By chance it would turn up in
  // about 1.3% of games; weighting should make that several times more likely.
  const t1 = places.filter((p) => p.tier === 1);
  const known = {};
  for (const p of t1.slice(1)) known[p.id] = { n: 1, best: 1000, last: 1000, at: now - 48 * hour };
  let seen = 0;
  for (let seed = 1; seed <= 200; seed++) {
    seen += buildGame(pools, { places: known }, { now, random: seeded(seed) }).some((s) => s.item.id === t1[0].id);
  }
  assert.ok(seen / 200 > 0.04, `unseen place appeared in ${seen} of 200 games`);
});

test('a place asked within the last few hours stays out of new games', () => {
  const now = Date.now();
  const brixton = places.find((p) => p.name === 'Brixton');
  for (const ago of [1000, 3600e3, 11 * 3600e3]) {
    const stats = { places: { [brixton.id]: { n: 1, best: 0, last: 0, at: now - ago } } };
    for (let seed = 1; seed <= 50; seed++) {
      const game = buildGame(pools, stats, { now, random: seeded(seed) });
      assert.ok(!game.some((s) => s.revisit));
      assert.ok(!game.some((s) => s.item.name === 'Brixton'));
    }
  }
});

test('a name asked as one kind of question rests as every other kind too', () => {
  const now = Date.now();
  const station = stations.find((s) => s.name === 'Brixton');
  const stats = { stations: { [station.id]: { n: 1, best: 900, last: 900, at: now - 3600e3 } } };
  for (let seed = 1; seed <= 200; seed++) {
    const game = buildGame(pools, stats, { now, random: seeded(seed) });
    assert.ok(!game.some((s) => s.item.name === 'Brixton'), `seed ${seed}`);
  }
});

test('a game never asks the same name twice', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const names = buildGame(pools, {}, { random: seeded(seed) }).map((s) => s.item.name.toLowerCase());
    assert.equal(new Set(names).size, STOPS, names.join(', '));
  }
});

test('when everything is resting, the stalest place comes up first', () => {
  const now = Date.now();
  const tiny = {
    ...pools,
    boroughs: pools.boroughs.filter((b) => b.tier === 1).slice(0, 2),
  };
  const [older, newer] = tiny.boroughs;
  const stats = {
    boroughs: {
      [older.id]: { n: 1, best: 900, last: 900, at: now - 2 * 3600e3 },
      [newer.id]: { n: 1, best: 900, last: 900, at: now - 3600e3 },
    },
  };
  for (let seed = 1; seed <= 20; seed++) {
    const game = buildGame(tiny, stats, { now, random: seeded(seed) });
    assert.equal(game.find((s) => s.kind === 'boroughs').item.id, older.id);
  }
});

test('formatKm', () => {
  assert.equal(formatKm(0.004), '10 m');
  assert.equal(formatKm(0.456), '460 m');
  assert.equal(formatKm(3.21), '3.2 km');
  assert.equal(formatKm(12.6), '13 km');
});
