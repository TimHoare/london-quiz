const R = 6371; // km

const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in km between two {lat, lng} points. */
export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing in degrees (0 = north, clockwise) from a to b. */
export function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

export function compass(deg) {
  return COMPASS[Math.round(deg / 45) % 8];
}

/** Ray-casting test; ring is an array of [lng, lat]. */
function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygons(geometry) {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

export function pointInGeometry(p, geometry) {
  return polygons(geometry).some(([outer, ...holes]) => inRing(p, outer) && !holes.some((h) => inRing(p, h)));
}

/**
 * Closest point on a polygon's outline to p, in km. Uses a local equirectangular
 * projection, which is plenty accurate at city scale.
 */
export function nearestOnGeometry(p, geometry) {
  const kx = R * rad(1) * Math.cos(rad(p.lat));
  const ky = R * rad(1);
  let best = { km: Infinity, lat: p.lat, lng: p.lng };
  for (const poly of polygons(geometry)) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const ax = (ring[i][0] - p.lng) * kx, ay = (ring[i][1] - p.lat) * ky;
        const bx = (ring[i + 1][0] - p.lng) * kx, by = (ring[i + 1][1] - p.lat) * ky;
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        const cx = ax + t * dx, cy = ay + t * dy;
        const d = Math.hypot(cx, cy);
        if (d < best.km) best = { km: d, lat: p.lat + cy / ky, lng: p.lng + cx / kx };
      }
    }
  }
  return best;
}

/** Area-weighted centroid of the largest ring — good enough for placing a label. */
export function centroid(geometry) {
  const ring = polygons(geometry).map((p) => p[0]).sort((a, b) => b.length - a.length)[0];
  let a = 0, x = 0, y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    x += (ring[j][0] + ring[i][0]) * f;
    y += (ring[j][1] + ring[i][1]) * f;
  }
  return { lng: x / (3 * a), lat: y / (3 * a) };
}

export function formatKm(km) {
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}
