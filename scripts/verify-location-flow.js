#!/usr/bin/env node
'use strict';

/**
 * End-to-end audit of the location pipeline for one device, plus a live watch
 * for the on-road test.
 *
 * Read-only. Everything it prints is derived from what the dashboard itself
 * reads, so a clean run here means the fleet map and route history are clean.
 *
 *   node scripts/verify-location-flow.js --name "Deepak"
 *   node scripts/verify-location-flow.js --device d9d5ca7874f95f87
 *   node scripts/verify-location-flow.js --device <id> --watch    # live test
 *
 * The watch mode is the one to run while the driver is actually moving: it
 * polls for newly stored fixes and prints each one as it lands, with the delay
 * between the fix being taken and it reaching the server.
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const WATCH = args.includes('--watch');
const POLL_MS = Number(argOf('--interval') || 15) * 1000;

const iso = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : 'null');
const pad = (s, n) => String(s).padStart(n);

/** Metres between two fixes. */
function metres(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const quantile = (sorted, f) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] : NaN;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  const Points = db.collection('locationpoints');
  const Sessions = db.collection('locationsessions');
  const States = db.collection('devicelocationstates');
  const Enrollments = db.collection('deviceenrollments');
  const Commands = db.collection('locationcommands');

  // ── Resolve the device ──────────────────────────────────────────────────
  let deviceId = argOf('--device');
  const name = argOf('--name');
  if (!deviceId) {
    if (!name) throw new Error('pass --device <deviceId> or --name <employee name>');
    const rx = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const hits = await Enrollments.find({ employeeName: rx }).toArray();
    const ids = [...new Set(hits.map((h) => h.deviceId))];
    if (ids.length === 0) throw new Error(`no enrollment matches "${name}"`);
    if (ids.length > 1) throw new Error(`"${name}" matches several devices: ${ids.join(', ')} — pass --device`);
    deviceId = ids[0];
  }

  // ── 1. Enrolment and capability ─────────────────────────────────────────
  const enrollments = await Enrollments.find({ deviceId }).sort({ createdAt: 1 }).toArray();
  console.log(`\n=== 1. ENROLMENT — device ${deviceId} ===`);
  for (const e of enrollments) {
    const flags = [
      e.revoked ? 'REVOKED' : 'active',
      `locationTracking=${e.capabilities && e.capabilities.locationTracking}`,
    ].join('  ');
    console.log(`  "${e.employeeName}"  employeeId=${e.employeeId}  ${flags}  enrolled ${iso(e.createdAt)}`);
  }
  const live = enrollments.filter((e) => !e.revoked);
  if (live.length > 1) {
    console.log(`  ! ${live.length} un-revoked enrolments share this device. Whichever token the`);
    console.log(`    handset holds decides the name stamped on its points, so per-employee`);
    console.log(`    reports will split. Revoke the ones that are no longer in use.`);
  }
  if (live.some((e) => !(e.capabilities && e.capabilities.locationTracking))) {
    console.log('  ! an active enrolment has locationTracking disabled — that device will not record.');
  }

  // ── 2. Live position, exactly as /api/fleet-map derives it ──────────────
  const state = await States.findOne({ deviceId });
  console.log('\n=== 2. LIVE POSITION (what the fleet map pin shows) ===');
  if (!state) {
    console.log('  no device state — this device has never reported.');
  } else {
    const now = Date.now();
    const fixMs = state.lastRecordedAt ? new Date(state.lastRecordedAt).getTime() : null;
    const heardMs = state.lastReceivedAt ? new Date(state.lastReceivedAt).getTime() : null;
    const ageMin = fixMs != null ? (now - fixMs) / 60000 : null;
    const heardMin = heardMs != null ? (now - heardMs) / 60000 : null;

    let reason = null;
    if (state.permissionStatus === 'DENIED' || state.trackingStatus === 'PERMISSION_DENIED') reason = 'Location permission is off';
    else if (state.gpsEnabled === false || state.trackingStatus === 'GPS_OFF') reason = 'Phone Location (GPS) is off';
    else if (state.trackingStatus === 'BACKGROUND_DENIED' || state.permissionStatus === 'FOREGROUND') reason = 'Not set to "Allow all the time"';
    else if (state.trackingStatus === 'NO_FIX') reason = 'Running but getting no GPS fix';
    else if (state.trackingStatus === 'IDLE') reason = 'Route ended — press Start';

    let freshness = 'unavailable';
    if (ageMin !== null && ageMin < 3) freshness = 'fresh';
    else if (!reason && heardMin !== null && heardMin < 15) freshness = 'parked';
    else if (ageMin !== null && ageMin < 15) freshness = 'stale';
    else if (ageMin !== null || heardMin !== null) freshness = 'old';

    const c = state.latestCoordinates || {};
    console.log(`  position     ${c.lat}, ${c.lng}   accuracy ${state.latestAccuracy != null ? state.latestAccuracy.toFixed(1) + 'm' : 'n/a'}`);
    console.log(`  last fix     ${iso(state.lastRecordedAt)}  (${ageMin === null ? '?' : ageMin.toFixed(0)} min ago)`);
    console.log(`  last heard   ${iso(state.lastReceivedAt)}  (${heardMin === null ? '?' : heardMin.toFixed(0)} min ago)`);
    console.log(`  reported     trackingStatus=${state.trackingStatus} gpsEnabled=${state.gpsEnabled} battery=${state.batteryPercent}%`);
    console.log(`  => map shows "${freshness}"${reason ? `  (${reason})` : ''}`);

    // The pin and the stored trail must agree. They stopped agreeing whenever a
    // backlog upload wrote an old fix over a newer one.
    const newest = (await Points.find({ deviceId }).sort({ recordedAt: -1 }).limit(1).toArray())[0];
    if (newest) {
      const drift = new Date(newest.recordedAt).getTime() - (fixMs || 0);
      if (drift > 60000) {
        console.log(`  ! PIN IS BEHIND THE TRAIL by ${(drift / 60000).toFixed(0)} min — newest stored fix is ${iso(newest.recordedAt)}`);
      } else {
        console.log('  pin matches the newest stored fix: OK');
      }
    }
  }

  // ── 3. Sessions and their aggregates ────────────────────────────────────
  const sessions = await Sessions.find({ deviceId }).sort({ startedAt: -1 }).limit(10).toArray();
  console.log('\n=== 3. SESSIONS (route history list) ===');
  let aggBad = 0;
  for (const s of sessions) {
    const actual = await Points.countDocuments({ sessionId: s.sessionId });
    const okAgg = (s.totalPoints || 0) === actual;
    if (!okAgg) aggBad++;
    console.log(
      `  ${s.sessionId}  ${String(s.status).padEnd(11)} points ${pad(s.totalPoints, 6)} / stored ${pad(actual, 6)} ${okAgg ? 'OK' : '<-- MISMATCH'}   ${iso(s.firstPointAt)} -> ${iso(s.lastPointAt)}`
    );
  }
  if (aggBad) console.log(`  ! ${aggBad} session(s) disagree with their stored points.`);

  // ── 4. Route-history integrity for the newest session ───────────────────
  if (sessions.length) {
    const cur = sessions[0];
    const pts = await Points.find({ sessionId: cur.sessionId }).sort({ sequenceNumber: 1 }).toArray();
    console.log(`\n=== 4. ROUTE HISTORY INTEGRITY — ${cur.sessionId} (${pts.length} points) ===`);
    if (pts.length < 2) {
      console.log('  too few points to check.');
    } else {
      let dupSeq = 0, outOfOrder = 0, backwards = 0, teleports = 0, mocks = 0, badAcc = 0, distance = 0;
      const seen = new Set();
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (seen.has(p.sequenceNumber)) dupSeq++;
        else seen.add(p.sequenceNumber);
        if (p.isMockLocation) mocks++;
        if (p.accuracyMeters == null || p.accuracyMeters <= 0 || p.accuracyMeters > 100) badAcc++;
        if (i === 0) continue;
        const prev = pts[i - 1];
        const dt = (new Date(p.recordedAt) - new Date(prev.recordedAt)) / 1000;
        if (dt < 0) backwards++;
        if (p.sequenceNumber < prev.sequenceNumber) outOfOrder++;
        const d = metres(
          { lat: prev.latitude, lng: prev.longitude },
          { lat: p.latitude, lng: p.longitude }
        );
        distance += d;
        if (dt > 0 && d / dt > 60) teleports++; // > 216 km/h between fixes
      }
      const spanH = (new Date(pts[pts.length - 1].recordedAt) - new Date(pts[0].recordedAt)) / 3600000;
      console.log(`  span ${iso(pts[0].recordedAt)} -> ${iso(pts[pts.length - 1].recordedAt)}  (${spanH.toFixed(1)} h, ${(distance / 1000).toFixed(2)} km)`);
      console.log(`  duplicate sequence numbers ${dupSeq}`);
      console.log(`  points out of order        ${outOfOrder}`);
      console.log(`  timestamps going backward  ${backwards}`);
      console.log(`  impossible jumps           ${teleports}`);
      console.log(`  mock locations             ${mocks}`);
      console.log(`  unusable accuracy          ${badAcc}`);
      const defects = dupSeq + outOfOrder + backwards + teleports + mocks + badAcc;
      console.log(`  => ${defects === 0 ? 'CLEAN — no missing or incorrect points' : `${defects} defect(s)`}`);
    }
  }

  // ── 5. Delivery latency, split by whether the vehicle was moving ────────
  const since = new Date(Date.now() - 30 * 86400000);
  const recent = await Points.find({ deviceId, recordedAt: { $gte: since } })
    .project({ recordedAt: 1, savedAt: 1, speedMetersPerSecond: 1 })
    .toArray();
  console.log('\n=== 5. DELIVERY LATENCY, last 30 days (fix taken -> stored on server) ===');
  if (!recent.length) {
    console.log('  no points in the window.');
  } else {
    const lagOf = (p) => (new Date(p.savedAt) - new Date(p.recordedAt)) / 1000;
    const groups = [
      ['moving', recent.filter((p) => (p.speedMetersPerSecond || 0) > 1.5)],
      ['stationary', recent.filter((p) => (p.speedMetersPerSecond || 0) <= 1.5)],
    ];
    for (const [label, g] of groups) {
      if (!g.length) { console.log(`  ${label.padEnd(11)} no points`); continue; }
      const L = g.map(lagOf).sort((a, b) => a - b);
      const within = ((L.filter((x) => x <= 120).length / L.length) * 100).toFixed(1);
      console.log(`  ${label.padEnd(11)} n=${pad(L.length, 6)}  p50 ${quantile(L, 0.5).toFixed(0)}s  p90 ${(quantile(L, 0.9) / 60).toFixed(1)}min  within 2 min ${within}%`);
    }
    const moving = recent
      .filter((p) => (p.speedMetersPerSecond || 0) > 1.5)
      .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
    const gaps = [];
    for (let i = 1; i < moving.length; i++) {
      const d = (new Date(moving[i].recordedAt) - new Date(moving[i - 1].recordedAt)) / 1000;
      if (d > 0 && d < 3600) gaps.push(d);
    }
    gaps.sort((a, b) => a - b);
    if (gaps.length) {
      console.log(`  sampling while moving: p50 ${quantile(gaps, 0.5).toFixed(1)}s  p90 ${quantile(gaps, 0.9).toFixed(1)}s`);
    }
  }

  // ── 6. Does the handset answer the dashboard? ───────────────────────────
  const cmds = await Commands.find({ deviceId }).sort({ createdAt: -1 }).limit(20).toArray();
  console.log('\n=== 6. COMMAND RESPONSIVENESS (last 20) ===');
  if (!cmds.length) {
    console.log('  none sent.');
  } else {
    const count = (s) => cmds.filter((c) => c.status === s).length;
    console.log(`  COMPLETED ${count('COMPLETED')}   EXPIRED ${count('EXPIRED')}   FAILED ${count('FAILED')}   awaiting ${cmds.filter((c) => c.status === 'REQUESTED' || c.status === 'DELIVERED').length}`);
    console.log(`  latest: ${iso(cmds[0].createdAt)}  ${cmds[0].type}  ${cmds[0].status}`);
    if (count('EXPIRED') > count('COMPLETED')) {
      console.log('  ! the handset is mostly not answering. Check that it is powered on, has data,');
      console.log('    has the shift started, and is exempt from battery optimisation.');
    }
  }

  if (!WATCH) {
    await mongoose.disconnect();
    return;
  }

  // ── Live watch: run this while the driver is moving ─────────────────────
  console.log(`\n=== LIVE WATCH — polling every ${POLL_MS / 1000}s, Ctrl+C to stop ===`);
  console.log('Drive the vehicle. Each new fix appears below as it reaches the server.\n');
  const seed = (await Points.find({ deviceId }).sort({ recordedAt: -1 }).limit(1).toArray())[0];
  let cursor = seed ? new Date(seed.recordedAt) : new Date(0);
  let last = seed ? { lat: seed.latitude, lng: seed.longitude } : null;
  let total = 0;
  console.log(`  baseline: newest fix is ${iso(cursor)}`);

  const tick = async () => {
    const fresh = await Points.find({ deviceId, recordedAt: { $gt: cursor } })
      .sort({ recordedAt: 1 })
      .toArray();
    if (!fresh.length) {
      process.stdout.write(`  ${new Date().toISOString().slice(11, 19)}  no new fixes (newest still ${iso(cursor)})\n`);
      return;
    }
    for (const p of fresh) {
      const lag = ((new Date(p.savedAt) - new Date(p.recordedAt)) / 1000).toFixed(0);
      const moved = last ? metres(last, { lat: p.latitude, lng: p.longitude }).toFixed(0) : '-';
      const kmh = p.speedMetersPerSecond != null ? (p.speedMetersPerSecond * 3.6).toFixed(0) : '?';
      console.log(
        `  ${iso(p.recordedAt)}  ${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}  +${pad(moved, 5)}m  ${pad(kmh, 3)}km/h  acc ${pad((p.accuracyMeters || 0).toFixed(0), 3)}m  delivered in ${pad(lag, 5)}s  seq ${p.sequenceNumber}`
      );
      last = { lat: p.latitude, lng: p.longitude };
      cursor = new Date(p.recordedAt);
      total++;
    }
    const st = await States.findOne({ deviceId });
    const pinOk = st && st.lastRecordedAt && new Date(st.lastRecordedAt).getTime() >= cursor.getTime();
    console.log(`  -- ${total} fix(es) so far; fleet-map pin ${pinOk ? 'is up to date' : 'IS BEHIND THE TRAIL'}\n`);
  };

  await tick();
  setInterval(() => { tick().catch((e) => console.error('poll error:', e.message)); }, POLL_MS);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
