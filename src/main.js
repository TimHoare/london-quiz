import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { KINDS, STOPS, MAX_POINTS, judge, verdict, gameVerdict, grade, buildGame } from './game.js';
import { centroid, distanceKm, formatKm } from './geo.js';
import * as progress from './progress.js';

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-GB');
const isSmall = () => window.matchMedia('(max-width: 640px)').matches;

// ---------------------------------------------------------------- map

const LONDON = L.latLngBounds([51.286, -0.51], [51.692, 0.334]);
// Satellite imagery: shows the layout of streets and buildings, and never a place name.
const SATELLITE = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
};

const map = L.map('map', {
  zoomControl: false,
  // Loose on purpose: on a phone the view is shifted well south of the results to
  // clear the bottom sheet, and tighter bounds would clamp it back behind the sheet.
  maxBounds: LONDON.pad(3),
  maxBoundsViscosity: 0.8,
  minZoom: 9,
  maxZoom: 17,
  zoomSnap: 0.25,
  doubleClickZoom: false,
});
map.attributionControl.setPrefix(false);
if (!isSmall()) L.control.zoom({ position: 'bottomright' }).addTo(map);

const roundLayer = L.layerGroup().addTo(map);
const overviewLayer = L.layerGroup().addTo(map);

/** Leave room for whichever panel is covering part of the map. */
function mapPadding() {
  const sheet = ['home', 'summary', 'progress', 'result'].map($).find((el) => !el.hidden);
  const top = $('play-ui').hidden ? 16 : $('play-top').offsetHeight + 24;
  if (isSmall()) return { paddingTopLeft: [16, top], paddingBottomRight: [16, (sheet ? sheet.offsetHeight : 70) + 24] };
  if (sheet && sheet.id !== 'result') return { paddingTopLeft: [sheet.offsetWidth + 48, 32], paddingBottomRight: [32, 32] };
  return { paddingTopLeft: [32, top], paddingBottomRight: [32, (sheet ? sheet.offsetHeight : 70) + 32] };
}

/**
 * Leaflet ignores a new zoom while one is still animating, which leaves the map
 * stuck if you tap through quickly. Hold the latest requested view until the
 * current zoom ends; anything requested in between is superseded.
 */
let pendingFit = null;
function fit(bounds, options) {
  pendingFit = () => map.fitBounds(bounds, { ...mapPadding(), ...options });
  if (!map._animatingZoom) runPendingFit();
}
function runPendingFit() {
  const go = pendingFit;
  pendingFit = null;
  go?.();
}
map.on('zoomend', () => {
  if (!map._animatingZoom) runPendingFit();
});

// On a portrait phone the whole of Greater London is tiny, so start a little tighter.
const fitLondon = (animate = true) => fit(isSmall() ? LONDON.pad(-0.12) : LONDON, { animate });

const pinIcon = (variant) => L.divIcon({ className: '', html: `<div class="pin pin--${variant}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
const GRADE_COLOUR = { good: '#0019a8', ok: '#e8a317', poor: '#c8102e' };

// ---------------------------------------------------------------- data

const LINE_COLOURS = {
  Bakerloo: ['#B36305', '#fff'],
  Central: ['#E32017', '#fff'],
  Circle: ['#FFD300', '#000'],
  District: ['#00782A', '#fff'],
  'Hammersmith & City': ['#F3A9BB', '#000'],
  Jubilee: ['#A0A5A9', '#000'],
  Metropolitan: ['#9B0056', '#fff'],
  Northern: ['#000000', '#fff'],
  Piccadilly: ['#003688', '#fff'],
  Victoria: ['#0098D4', '#fff'],
  'Waterloo & City': ['#95CDBA', '#000'],
};
const SOUTH_OF_RIVER = new Set(['Bexley', 'Bromley', 'Croydon', 'Greenwich', 'Kingston upon Thames', 'Lambeth', 'Lewisham',
  'Merton', 'Southwark', 'Sutton', 'Wandsworth']);
const ROYAL = new Set(['Kensington and Chelsea', 'Greenwich', 'Kingston upon Thames']);

/** The red line along the bottom of a London street sign. */
function boroughSignText(name) {
  if (!name || name === 'outside Greater London') return 'Outside Greater London';
  if (name === 'City of London') return 'City of London';
  if (name === 'Westminster') return 'City of Westminster';
  return `${ROYAL.has(name) ? 'Royal' : 'London'} Borough of ${name}`;
}

function riverSide(name) {
  if (name === 'Richmond upon Thames') return 'on both banks of the river';
  return SOUTH_OF_RIVER.has(name) ? 'south of the river' : 'north of the river';
}

const pools = {};

async function loadData() {
  const files = { places: 'places.json', stations: 'stations.json', landmarks: 'landmarks.json', boroughs: 'boroughs.geojson' };
  await Promise.all(Object.entries(files).map(async ([k, f]) => {
    const res = await fetch(`${import.meta.env.BASE_URL}data/${f}`);
    if (!res.ok) throw new Error(`Couldn't load ${f} (${res.status})`);
    pools[k] = await res.json();
  }));
  pools.boroughs = pools.boroughs.features.map((f) => ({ ...f.properties, geometry: f.geometry, ...centroid(f.geometry) }));
}

// ---------------------------------------------------------------- screens

let game = null;
let phase = 'home'; // home | picking | result | summary | progress

function show(which) {
  phase = which;
  $('home').hidden = which !== 'home';
  $('play-ui').hidden = !(which === 'picking' || which === 'result');
  $('result').hidden = which !== 'result';
  $('summary').hidden = which !== 'summary';
  $('progress').hidden = which !== 'progress';
  $('map').classList.toggle('is-picking', which === 'picking');
}

function toHome() {
  game = null;
  roundLayer.clearLayers();
  overviewLayer.clearLayers();
  const best = progress.bestScore('game');
  const bestEl = $('best');
  bestEl.replaceChildren();
  if (best != null) {
    const n = document.createElement('b');
    n.textContent = fmt.format(best);
    bestEl.append('Your best: ', n, ` of ${fmt.format(STOPS * MAX_POINTS)}`);
  }
  show('home');
  fitLondon();
}

// ---------------------------------------------------------------- game

function startGame() {
  const stats = Object.fromEntries(Object.keys(KINDS).map((k) => [k, progress.statsFor(k)]));
  game = { stops: buildGame(pools, stats), i: 0, score: 0, results: [] };
  overviewLayer.clearLayers();
  nextStop();
}

/** The game's progress drawn as a tube line: one station per stop. */
function renderLine() {
  const line = $('line');
  line.replaceChildren();
  game.stops.forEach((_, i) => {
    const li = document.createElement('li');
    const r = game.results[i];
    li.className = r ? `stop stop--${grade(r.res.points)}` : i === game.i ? 'stop stop--current' : 'stop';
    li.setAttribute('aria-label', r ? `Stop ${i + 1}: ${r.res.points} points` : `Stop ${i + 1}`);
    if (i === game.i) li.setAttribute('aria-current', 'step');
    line.append(li);
  });
}

function nextStop() {
  const { kind, item } = game.stops[game.i];
  game.guess = null;
  game.guessMarker = null;
  game.hinted = false;
  roundLayer.clearLayers();

  const plate = $('question');
  plate.className = `plate plate--question plate--${kind}`;
  $('q-name').textContent = item.name;
  $('q-qualifier').hidden = !item.qualifier;
  $('q-qualifier').textContent = item.qualifier ? `in ${item.qualifier}` : '';
  $('q-hint-text').hidden = true;
  $('q-hint-text').replaceChildren();
  $('hint').hidden = false;
  $('hud-score').textContent = fmt.format(game.score);
  $('confirm').hidden = true;
  $('instruction').hidden = false;
  $('instruction').classList.remove('instruction--hint');
  $('instruction').textContent = isSmall()
    ? `Tap where this ${KINDS[kind].noun} is`
    : `Click the map where you think this ${KINDS[kind].noun} is`;
  renderLine();

  show('picking');
  void plate.offsetWidth; // restart the entrance animation
  plate.classList.add('is-new');
  fitLondon();
}

function useHint() {
  if (phase !== 'picking' || game.hinted) return;
  game.hinted = true;
  showClue();
}

/** Fill the sign's bottom line: the borough, or the lines for a station. */
function showClue() {
  const { kind, item } = game.stops[game.i];
  const el = $('q-hint-text');
  el.replaceChildren();
  if (kind === 'stations') {
    for (const line of item.lines) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const [bg, fg] = LINE_COLOURS[line] ?? ['#555', '#fff'];
      chip.style.background = bg;
      chip.style.color = fg;
      chip.textContent = line;
      el.append(chip);
    }
  } else if (kind === 'boroughs') {
    el.textContent = `${item.tier === 1 ? 'Inner' : 'Outer'} London, ${riverSide(item.name)}`;
  } else {
    el.textContent = boroughSignText(item.borough);
  }
  el.hidden = false;
  $('hint').hidden = true;
}

function placeGuess(latlng) {
  if (phase !== 'picking') return;
  game.guess = { lat: latlng.lat, lng: latlng.lng };
  if (game.guessMarker) game.guessMarker.setLatLng(latlng);
  else game.guessMarker = L.marker(latlng, { icon: pinIcon('guess'), keyboard: false, interactive: false }).addTo(roundLayer);
  // Keep a quieter hint above the button so people know the pin can still move.
  $('instruction').classList.add('instruction--hint');
  $('instruction').textContent = `${isSmall() ? 'Tap' : 'Click'} again to move your pin`;
  $('confirm').hidden = false;
}

function confirmGuess() {
  if (phase !== 'picking' || !game.guess) return;
  const { kind, item } = game.stops[game.i];
  const res = judge(item, game.guess, kind, game.hinted);
  game.score += res.points;
  game.results.push({ kind, item, guess: game.guess, res, hinted: game.hinted });
  progress.record(kind, item.id, res.points, res.km);

  showClue(); // the clue is worth learning, so reveal it once the guess is in
  drawReveal(roundLayer, game.results.at(-1));
  $('hud-score').textContent = fmt.format(game.score);
  $('confirm').hidden = true;
  $('instruction').hidden = true;
  renderLine();

  $('result').className = `sheet result result--${grade(res.points)}`;
  $('r-verdict').textContent = kind === 'boroughs' && res.inside && !game.hinted ? 'Spot on' : verdict(res.points);
  $('r-points').textContent = `+${fmt.format(res.points)}`;
  $('r-clue').hidden = !game.hinted;
  $('r-detail').replaceChildren(...describe(kind, res));
  $('r-context').textContent = context(kind, item);
  $('next').textContent = game.i === STOPS - 1 ? 'See how you did' : 'Next stop';
  show('result');
  $('next').focus({ preventScroll: true });
  zoomTo(game.results.at(-1), 12.75);
}

function zoomTo(r, maxZoom) {
  const b = L.latLngBounds([r.guess, r.res.nearest]);
  if (r.kind === 'boroughs') b.extend(L.geoJSON(r.item.geometry).getBounds());
  fit(b, { maxZoom });
}

/** The headline fact of a result: how far off, and which way to look. */
function describe(kind, res) {
  const strong = (text) => Object.assign(document.createElement('strong'), { textContent: text });
  if (kind === 'boroughs') {
    if (res.inside) return [strong('Inside the borough')];
    return [strong(formatKm(res.km)), ` outside. The borough lies to the ${res.direction}.`];
  }
  if (res.km < 0.05) return [strong('Right on top of it')];
  return [strong(formatKm(res.km)), ` ${res.direction} of your pin`];
}

const listing = (names) => names.join(', ').replace(/, ([^,]*)$/, ' and $1');

/** Best-known neighbourhoods closest to a point, so each answer teaches its surroundings. */
function nearby(point, n, skipName) {
  return pools.places
    .filter((p) => p.tier <= 2 && p.name !== skipName)
    .map((p) => ({ name: p.name, km: distanceKm(point, p) }))
    .filter((p) => p.km < 5)
    .sort((a, b) => a.km - b.km)
    .slice(0, n)
    .map((p) => p.name);
}

function context(kind, item) {
  if (kind === 'boroughs') {
    const inside = pools.places.filter((p) => p.borough === item.name).sort((a, b) => a.tier - b.tier).slice(0, 3);
    return inside.length ? `Takes in ${listing(inside.map((p) => p.name))}.` : '';
  }
  const near = nearby(item, kind === 'places' ? 3 : 2, item.name);
  const nearText = near.length ? `Nearby: ${listing(near)}.` : '';
  return kind === 'stations' ? `Zone ${item.zone}. ${nearText}`.trim() : nearText;
}

/**
 * Draw one answer: the guess (black), a dashed line, and the answer pin coloured
 * by how well you did. Returns the answer marker so its label can be opened later.
 */
function drawReveal(layer, { kind, item, guess, res }, { small = false, permanentLabel = true } = {}) {
  const colour = GRADE_COLOUR[grade(res.points)];
  if (kind === 'boroughs') {
    L.geoJSON(item.geometry, {
      interactive: false,
      style: { color: colour, weight: 2.5, fillColor: colour, fillOpacity: 0.14 },
    }).addTo(layer);
  }
  if (!(kind === 'boroughs' && res.inside)) {
    L.polyline([guess, res.nearest], { color: '#fff', weight: small ? 1.5 : 2, dashArray: '6 6', interactive: false }).addTo(layer);
  }
  L.marker(guess, { icon: pinIcon('guess'), keyboard: false, interactive: false }).addTo(layer);
  const at = kind === 'boroughs' ? { lat: item.lat, lng: item.lng } : res.nearest;
  const answer = L.marker(at, {
    icon: kind === 'boroughs' ? L.divIcon({ className: '', iconSize: [0, 0] }) : pinIcon(`answer pin--${grade(res.points)}`),
    keyboard: false,
    interactive: false,
  }).addTo(layer).bindTooltip(item.name, {
    permanent: permanentLabel,
    direction: kind === 'boroughs' ? 'center' : 'top',
    offset: kind === 'boroughs' ? [0, 0] : [0, -12],
    className: `map-label${small ? ' map-label--small' : ''}`,
  });
  if (permanentLabel) answer.openTooltip();
  return answer;
}

function next() {
  if (phase !== 'result') return;
  game.i += 1;
  if (game.i < STOPS) nextStop();
  else finish();
}

function finish() {
  roundLayer.clearLayers();
  overviewLayer.clearLayers();
  progress.submitScore('game', game.score);
  $('s-score').textContent = fmt.format(game.score);
  $('s-title').textContent = gameVerdict(game.score);
  $('s-hint').textContent = `${isSmall() ? 'Tap' : 'Click'} a stop to see it on the map.`;

  // Ten permanent labels pile up on a phone, so there they appear one at a time.
  const permanentLabel = !isSmall();
  const list = $('s-list');
  list.replaceChildren();
  const bounds = L.latLngBounds([]);
  let openLabel = null;
  for (const r of game.results) {
    const answer = drawReveal(overviewLayer, r, { small: true, permanentLabel });
    bounds.extend(r.guess).extend(r.res.nearest);
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.className = `stop-row stop-row--${grade(r.res.points)}`;
    li.innerHTML = '<span class="s-dot"></span><span class="s-name"></span><span class="s-km"></span><span class="s-pts"></span>';
    li.querySelector('.s-name').textContent = r.item.name;
    if (r.hinted) li.querySelector('.s-name').append(Object.assign(document.createElement('span'), { className: 's-clue', textContent: 'clue' }));
    li.querySelector('.s-km').textContent = r.kind === 'boroughs' && r.res.inside ? 'inside' : formatKm(r.res.km);
    li.querySelector('.s-pts').textContent = fmt.format(r.res.points);
    const select = () => {
      list.querySelector('.is-selected')?.classList.remove('is-selected');
      li.classList.add('is-selected');
      zoomTo(r, 14);
      if (!permanentLabel) {
        openLabel?.closeTooltip();
        answer.openTooltip();
        openLabel = answer;
      }
    };
    li.addEventListener('click', select);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
    });
    list.append(li);
  }
  show('summary');
  if (bounds.isValid()) fit(bounds, { maxZoom: 13 });
}

// ---------------------------------------------------------------- progress map

const MASTERY = {
  known: { label: 'You know these', colour: '#0019a8' },
  shaky: { label: 'Nearly there', colour: '#e8a317' },
  lost: { label: 'Still lost', colour: '#c8102e' },
};

function openProgress() {
  overviewLayer.clearLayers();
  const counts = { known: 0, shaky: 0, lost: 0 };
  for (const kind of Object.keys(KINDS)) {
    const stats = progress.statsFor(kind);
    for (const it of pools[kind]) {
      const m = progress.mastery(stats[it.id]);
      if (m === 'unseen') continue;
      counts[m] += 1;
      const colour = MASTERY[m].colour;
      const layer = kind === 'boroughs'
        ? L.geoJSON(it.geometry, { style: { color: colour, weight: 1.5, fillColor: colour, fillOpacity: 0.22 } })
        : L.circleMarker(it, { radius: isSmall() ? 7 : 6, color: '#fff', weight: 1.5, fillColor: colour, fillOpacity: 0.95 });
      layer.bindTooltip(it.name, { className: 'map-label map-label--small', direction: 'top', sticky: kind === 'boroughs' });
      layer.addTo(overviewLayer);
    }
  }
  const total = counts.known + counts.shaky + counts.lost;
  const everything = Object.values(pools).reduce((n, list) => n + list.length, 0);
  $('p-count').textContent = total ? `${fmt.format(total)} of ${fmt.format(everything)} places so far` : '';
  $('p-help').textContent = total
    ? `Every place you've been asked, coloured by your recent guesses. ${isSmall() ? 'Tap' : 'Hover over'} a dot to see its name.`
    : 'Nothing here yet. Play a game and the places you were asked will appear on the map.';
  // The three counts as one stacked bar: a picture of how much is known.
  const share = $('p-share');
  share.replaceChildren();
  share.hidden = !total;
  for (const [k, m] of Object.entries(MASTERY)) {
    if (!counts[k]) continue;
    const seg = document.createElement('span');
    seg.style.flexGrow = counts[k];
    seg.style.background = m.colour;
    share.append(seg);
  }
  const legend = $('p-legend');
  legend.replaceChildren();
  legend.hidden = !total;
  for (const [k, m] of Object.entries(MASTERY)) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="swatch"></span><span></span><span></span>';
    li.children[0].style.background = m.colour;
    li.children[1].textContent = m.label;
    li.children[2].textContent = counts[k];
    legend.append(li);
  }
  $('p-reset').hidden = !total;
  show('progress');
  fitLondon();
}

// ---------------------------------------------------------------- wiring

function bind() {
  $('play').addEventListener('click', startGame);
  $('again').addEventListener('click', startGame);
  $('open-progress').addEventListener('click', openProgress);
  $('hint').addEventListener('click', useHint);
  $('confirm').addEventListener('click', confirmGuess);
  $('next').addEventListener('click', next);
  $('quit').addEventListener('click', () => {
    if (!game?.results.length || confirm("Leave this game? Your score won't count, but the places you've done are saved.")) toHome();
  });
  $('home-btn').addEventListener('click', toHome);
  $('p-back').addEventListener('click', toHome);
  $('p-play').addEventListener('click', startGame);
  $('p-reset').addEventListener('click', () => {
    if (confirm('Forget everything you have played? Your best score and the places you missed will be cleared.')) {
      progress.resetProgress();
      openProgress();
    }
  });
  map.on('click', (e) => placeGuess(e.latlng));

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('button, input, li')) return; // focused controls handle their own keys
    if (e.key === 'Enter' || e.key === ' ') {
      if (phase === 'picking' && game?.guess) { e.preventDefault(); confirmGuess(); }
      else if (phase === 'result') { e.preventDefault(); next(); }
    } else if (e.key.toLowerCase() === 'h' && phase === 'picking') {
      useHint();
    }
  });
}

async function boot() {
  fitLondon(false);
  L.tileLayer(SATELLITE.url, { attribution: SATELLITE.attribution }).addTo(map);
  try {
    await loadData();
  } catch (err) {
    $('home').querySelector('.home-copy').textContent = `${err.message}. Check the dev server is running, then reload.`;
    $('play').disabled = true;
    return;
  }
  bind();
  toHome();
  if (import.meta.env.DEV) {
    window.__quiz = { pools, map, placeGuess, confirmGuess, get game() { return game; }, get phase() { return phase; } };
  }
}

boot();
