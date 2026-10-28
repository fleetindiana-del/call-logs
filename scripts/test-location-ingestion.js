/**
 * End-to-end test of the location ingestion path against a scratch database.
 * Mounts the real locationRoutes.js on a real express app, posts real batches,
 * then reads back what the fleet map and route history would read.
 *
 * Writes go to a throwaway database on the same cluster; production
 * collections are never touched. The scratch db is dropped at the end.
 */
const path = require('path');
const BE = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(BE, '.env.local') });

const express = require('express');
const mongoose = require('mongoose');
const mountLocationRoutes = require(process.env.ROUTES_PATH || path.join(BE, 'locationRoutes.js'));

const DEV = 'TEST_DEVICE_E2E';
const TOKEN = 'test-token-e2e';
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
};

// Scratch database on the same cluster.
const uri = process.env.MONGODB_URI.replace(/\/([^/?]*)(\?|$)/, '/fleet_e2e_scratch$2');

(async () => {
  await mongoose.connect(uri);
  console.log('scratch db:', mongoose.connection.name);
  if (!/scratch/.test(mongoose.connection.name)) throw new Error('refusing to run outside a scratch db');
  await mongoose.connection.dropDatabase();

  // Minimal stand-ins for the deps server.js injects.
  const enrollment = {
    deviceId: DEV, deviceToken: TOKEN, employeeId: 'E1',
    employeeName: 'Deepakbhai khambhala', companyId: 'C1',
    vehicle: { id: 'V1', registration: 'GJ-01-AA-1111' }, revoked: false,
  };
  const DeviceEnrollment = { findOne: async () => enrollment };

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  mountLocationRoutes(app, {
    FcmToken: { findOne: async () => null },
    DeviceEnrollment,
    loadFirebaseServiceAccount: () => null,
    sendFcmDataToTokens: async () => ({}),
    authenticate: (req, res, next) => { req.isAdmin = true; next(); },
    GoogleAuth: class {},
  });

  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const post = async (p, body) => {
    const r = await fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };
  const get = async (p) => {
    const r = await fetch(base + p, { headers: { 'x-api-key': process.env.API_KEY } });
    return { status: r.status, json: await r.json() };
  };

  const OLD = 'session_OLD', NEW = 'session_NEW';
  const T = (s) => new Date(Date.parse('2026-09-21T00:00:00Z') + s * 1000).toISOString();
  const mk = (id, sess, secs, lat, lng, seq, extra = {}) => ({
    pointId: id, sessionId: sess, sequenceNumber: seq,
    latitude: lat, longitude: lng, accuracyMeters: 8, speedMetersPerSecond: 5,
    recordedAt: T(secs), batteryPercent: 70, provider: 'fused', isMockLocation: false, ...extra,
  });

  // ── 1. Live tracking: a normal moving batch ──────────────────────────────
  console.log('\n[1] live location received and stored');
  let r = await post('/api/location/batch', {
    deviceId: DEV, sessionId: NEW,
    points: [mk('p1', NEW, 0, 22.7100, 71.6400, 1), mk('p2', NEW, 60, 22.7150, 71.6450, 2)],
  });
  ok('batch accepted', r.status === 200 && r.json.acceptedPointIds.length === 2, JSON.stringify(r.json));
  r = await get(`/api/location/latest?deviceId=${DEV}`);
  const s1 = r.json.states[0];
  ok('live pin = newest fix', s1.latestCoordinates.lat === 22.7150 && s1.latestCoordinates.lng === 71.6450,
     JSON.stringify(s1.latestCoordinates));
  ok('lastRecordedAt = newest fix time', new Date(s1.lastRecordedAt).toISOString() === T(60));
  ok('identity carried through', s1.employeeName === 'Deepakbhai khambhala' && s1.companyId === 'C1');

  // ── 2. Movement continues: the pin must advance ──────────────────────────
  console.log('\n[2] pin advances as the vehicle moves');
  await post('/api/location/batch', { deviceId: DEV, sessionId: NEW, points: [mk('p3', NEW, 120, 22.7200, 71.6500, 3)] });
  r = await get(`/api/location/latest?deviceId=${DEV}`);
  ok('pin moved forward', r.json.states[0].latestCoordinates.lat === 22.7200);

  // ── 3. THE REGRESSION: a stale backlog flush must not move the pin back ──
  console.log('\n[3] stale backlog does not overwrite the live position');
  const backlog = [
    mk('b1', OLD, -9 * 86400, 22.9999, 71.9999, 500),
    mk('b2', OLD, -9 * 86400 + 30, 22.9998, 71.9998, 501),
  ];
  r = await post('/api/location/batch', { deviceId: DEV, sessionId: OLD, points: backlog });
  ok('backlog stored', r.json.acceptedPointIds.length === 2);
  r = await get(`/api/location/latest?deviceId=${DEV}`);
  const s3 = r.json.states[0];
  ok('pin still on the NEWEST fix, not the backlog', s3.latestCoordinates.lat === 22.7200,
     `got ${s3.latestCoordinates.lat},${s3.latestCoordinates.lng}`);
  ok('lastRecordedAt still newest', new Date(s3.lastRecordedAt).toISOString() === T(120),
     new Date(s3.lastRecordedAt).toISOString());
  ok('lastReceivedAt DID advance (we did hear from the phone)',
     new Date(s3.lastReceivedAt).getTime() > new Date(s3.lastRecordedAt).getTime());

  // ── 4. Mixed-session batch: aggregates land on the right session ─────────
  console.log('\n[4] a batch straddling two sessions credits each correctly');
  r = await post('/api/location/batch', {
    deviceId: DEV, sessionId: OLD, // device sends first point's session as the header
    points: [
      mk('m1', OLD, -9 * 86400 + 60, 22.9997, 71.9997, 502),
      mk('m2', NEW, 180, 22.7250, 71.6550, 4),
      mk('m3', NEW, 240, 22.7300, 71.6600, 5),
    ],
  });
  ok('mixed batch accepted', r.json.acceptedPointIds.length === 3);
  r = await get(`/api/location/sessions?deviceId=${DEV}`);
  const sess = Object.fromEntries(r.json.sessions.map(s => [s.sessionId, s]));
  const countIn = async (sid) => mongoose.connection.db.collection('locationpoints').countDocuments({ sessionId: sid });
  const nOld = await countIn(OLD), nNew = await countIn(NEW);
  ok('OLD totalPoints matches stored points', sess[OLD].totalPoints === nOld, `${sess[OLD].totalPoints} vs ${nOld}`);
  ok('NEW totalPoints matches stored points', sess[NEW].totalPoints === nNew, `${sess[NEW].totalPoints} vs ${nNew}`);
  ok('NEW lastPointAt is its own newest fix', new Date(sess[NEW].lastPointAt).toISOString() === T(240),
     sess[NEW].lastPointAt);
  ok('OLD lastPointAt not polluted by NEW points',
     new Date(sess[OLD].lastPointAt).getTime() < Date.parse(T(0)), sess[OLD].lastPointAt);
  ok('NEW firstPointAt set', sess[NEW].firstPointAt && new Date(sess[NEW].firstPointAt).toISOString() === T(0),
     String(sess[NEW].firstPointAt));

  // ── 5. Route history reads back complete and ordered ─────────────────────
  console.log('\n[5] route history is complete and in order');
  r = await get(`/api/location/history?sessionId=${NEW}`);
  const hist = r.json.points;
  ok('all 5 NEW points returned', hist.length === 5, `got ${hist.length}`);
  const seqs = hist.map(p => p.sequenceNumber);
  ok('ordered by sequence, no gaps', JSON.stringify(seqs) === JSON.stringify([1, 2, 3, 4, 5]), JSON.stringify(seqs));
  const times = hist.map(p => new Date(p.recordedAt).getTime());
  ok('timestamps strictly increasing', times.every((t, i) => i === 0 || t > times[i - 1]));
  ok('no OLD-session points leaked in', hist.every(p => p.sessionId === NEW));

  // ── 6. Idempotency: a replayed batch must not double-count ───────────────
  console.log('\n[6] replayed batch does not duplicate or inflate');
  const before = (await get(`/api/location/sessions?deviceId=${DEV}`)).json.sessions.find(s => s.sessionId === NEW).totalPoints;
  r = await post('/api/location/batch', { deviceId: DEV, sessionId: NEW, points: [mk('m3', NEW, 240, 22.7300, 71.6600, 5)] });
  ok('replay reported as duplicate', r.json.duplicatePointIds.includes('m3') && r.json.acceptedPointIds.length === 0);
  const after = (await get(`/api/location/sessions?deviceId=${DEV}`)).json.sessions.find(s => s.sessionId === NEW).totalPoints;
  ok('totalPoints unchanged after replay', before === after, `${before} -> ${after}`);
  ok('point count still matches', after === await countIn(NEW));

  // ── 7. Quality gate still rejects garbage ────────────────────────────────
  console.log('\n[7] bad fixes are rejected, good ones kept');
  r = await post('/api/location/batch', {
    deviceId: DEV, sessionId: NEW,
    points: [
      mk('bad1', NEW, 300, 0, 0, 6),
      mk('bad2', NEW, 301, 22.73, 71.66, 7, { accuracyMeters: 500 }),
      mk('good', NEW, 302, 22.7350, 71.6650, 8),
    ],
  });
  ok('null-island rejected', r.json.rejected.some(x => x.pointId === 'bad1'));
  ok('low-accuracy rejected', r.json.rejected.some(x => x.pointId === 'bad2'));
  ok('good point accepted', r.json.acceptedPointIds.includes('good'));
  r = await get(`/api/location/latest?deviceId=${DEV}`);
  ok('pin advanced to the good fix', r.json.states[0].latestCoordinates.lat === 22.7350);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  server.close();
  await mongoose.disconnect();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e); process.exit(1); });
