// HTTP OwnTracks adapter. The public OBS endpoint never receives these credentials.
import { validateGpsSample, GPS_FIX_MAX_AGE_MS } from './chase-obs.js';

const MAX_FUTURE_DRIFT_MS = 30_000;

export function parseOwnTracksLocation(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'Expected an OwnTracks JSON object' };
  }
  if (payload._type !== 'location') return { ignored: true };
  if (!Number.isInteger(payload.tst) || payload.tst <= 0) {
    return { error: 'OwnTracks fix timestamp is required' };
  }
  const fixTime = payload.tst * 1000;
  if (!Number.isFinite(fixTime) || fixTime > now + MAX_FUTURE_DRIFT_MS) {
    return { error: 'OwnTracks timestamp is invalid' };
  }
  // OwnTracks retransmits queued location reports when connectivity recovers.
  // Acknowledge late points without replacing newer, current chase positions.
  if (now - fixTime > GPS_FIX_MAX_AGE_MS) return { ignored: true };
  if (typeof payload.lat !== 'number' || typeof payload.lon !== 'number') {
    return { error: 'Missing or invalid OwnTracks coordinates' };
  }
  const speedKmh = payload.vel === undefined || payload.vel === null ? null : Number(payload.vel);
  if (speedKmh !== null && (!Number.isFinite(speedKmh) || speedKmh < 0)) {
    return { error: 'Invalid OwnTracks speed' };
  }
  return validateGpsSample({
    lat: payload.lat,
    lon: payload.lon,
    accuracy: payload.acc ?? null,
    // OwnTracks "vel" is km/h; chase_speed is meters/second.
    speed: speedKmh === null ? null : speedKmh / 3.6,
    heading: payload.cog ?? null,
    updatedAt: new Date(fixTime).toISOString()
  }, now);
}

export async function verifyOwnTracksAuth(authorization, username, password) {
  if (!password || !username || !authorization?.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = atob(authorization.slice(6)); } catch (_error) { return false; }
  const sep = decoded.indexOf(':');
  if (sep < 1) return false;
  const submitted = decoded.slice(0, sep) + ':' + decoded.slice(sep + 1);
  const expected = String(username) + ':' + String(password);
  // Compare fixed-size SHA-256 digests without short-circuiting on a character.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(submitted)),
    crypto.subtle.digest('SHA-256', enc.encode(expected))
  ]);
  const av = new Uint8Array(a), bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}
