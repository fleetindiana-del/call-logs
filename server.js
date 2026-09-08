const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const morgan   = require('morgan');
require('dotenv').config();
const crypto = require('crypto');

const app         = express();
const PORT        = process.env.PORT        || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/callmonitor";
const API_KEY     = process.env.API_KEY     || "change-this-key";

// ─── Middleware ───────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));

const authenticate = (req, res, next) => {
  const key = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];
  
  if (API_KEY && key === API_KEY) {
    return next();
  }

  // Allow Vercel Cron jobs to hit protected endpoints
  if (process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized — invalid credentials' });
};

// ─── Schema ───────────────────────────────────────────
const callLogSchema = new mongoose.Schema({
  phoneNumber:  { type: String, required: true, trim: true },
  contactName:  { type: String, default: 'Unknown' },
  callType:     { type: String, enum: ['INCOMING', 'OUTGOING', 'MISSED', 'UNKNOWN'], required: true },
  duration:     { type: Number, default: 0 },
  timestamp:    { type: Date,   required: true },
  deviceId:     { type: String, required: true },
  employeeName: { type: String, default: 'Unknown' },
  syncedAt:     { type: Date,   default: Date.now }
}, { timestamps: true });

callLogSchema.index({ deviceId: 1, timestamp: -1 });
callLogSchema.index({ employeeName: 1 });
callLogSchema.index({ timestamp: -1 });
callLogSchema.index({ phoneNumber: 1 });
// Prevent the same physical call from being stored multiple times
callLogSchema.index(
  { deviceId: 1, phoneNumber: 1, timestamp: 1, duration: 1 },
  { unique: true }
);

const CallLog = mongoose.model('CallLog', callLogSchema);

function normalizeCallType(raw) {
  const u = String(raw == null ? '' : raw).toUpperCase().trim();
  if (['INCOMING', 'OUTGOING', 'MISSED', 'UNKNOWN'].includes(u)) return u;
  return 'UNKNOWN';
}

const toggleLogSchema = new mongoose.Schema({
  deviceId:     { type: String, required: true },
  employeeName: { type: String, default: 'Unknown' },
  status:       {
    type: String,
    enum: [
      'ON',
      'OFF',
      'PERMISSION_DENIED',
      'PERMISSION_RESTORED',
      'ADMIN_DISABLED',
      'ADMIN_ENABLED',
    ],
    required: true,
  },
  reason:       { type: String },
  timestamp:    { type: Date, required: true }
}, { timestamps: true });

toggleLogSchema.index({ deviceId: 1, timestamp: -1 });
toggleLogSchema.index({ employeeName: 1 });

const ToggleLog = mongoose.model('ToggleLog', toggleLogSchema);

const contactSchema = new mongoose.Schema({
  deviceId:     { type: String, required: true },
  employeeName: { type: String, default: 'Unknown' },
  contactName:  { type: String, required: true },
  phoneNumber:  { type: String, required: true },
  timestamp:    { type: Date, required: true },
  syncedAt:     { type: Date, default: Date.now }
}, { timestamps: true });

contactSchema.index({ deviceId: 1, phoneNumber: 1 }, { unique: true });
contactSchema.index({ employeeName: 1 });

const Contact = mongoose.model('Contact', contactSchema);

// ─── FCM Token Schema ───────────────────────────────────────────
const fcmTokenSchema = new mongoose.Schema({
  deviceId:  { type: String, required: true, unique: true },
  token:     { type: String, required: true },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

fcmTokenSchema.index({ deviceId: 1 }, { unique: true });

const FcmToken = mongoose.model('FcmToken', fcmTokenSchema);

// ─── Enrollment Schemas ────────────────────────────────────────

const enrollmentCodeSchema = new mongoose.Schema({
  code:         { type: String, required: true, unique: true },
  companyId:    { type: String },
  employeeId:   { type: String, required: true },
  employeeName: { type: String, required: true },
  role:         { type: String, enum: ['driver', 'employee'], required: true },
  capabilities: {
    callMonitoring:     { type: Boolean, default: false },
    locationTracking:   { type: Boolean, default: false },
    expenseManagement:  { type: Boolean, default: false },
  },
  vehicle:   { id: String, registration: String },
  serverUrl: { type: String },
  apiKey:    { type: String },
  driverId:  { type: String },
  usedAt:    { type: Date },
  expiresAt: { type: Date },
  revoked:   { type: Boolean, default: false },
}, { timestamps: true });

enrollmentCodeSchema.index({ code: 1 }, { unique: true });

const EnrollmentCode = mongoose.model('EnrollmentCode', enrollmentCodeSchema);

const deviceEnrollmentSchema = new mongoose.Schema({
  deviceId:     { type: String, required: true },
  employeeId:   { type: String },
  employeeName: { type: String },
  role:         { type: String },
  capabilities: {
    callMonitoring:    { type: Boolean, default: false },
    locationTracking:  { type: Boolean, default: false },
    expenseManagement: { type: Boolean, default: false },
  },
  vehicle:     { id: String, registration: String },
  companyId:   { type: String },
  driverId:    { type: String },
  deviceToken: { type: String, required: true, unique: true },
  revoked:     { type: Boolean, default: false },
}, { timestamps: true });

deviceEnrollmentSchema.index({ deviceToken: 1 }, { unique: true });
deviceEnrollmentSchema.index({ deviceId: 1 });

const DeviceEnrollment = mongoose.model('DeviceEnrollment', deviceEnrollmentSchema);

// ─── MongoDB Serverless Connection ───────────────────────
let isConnected;

const connectDB = async () => {
  if (isConnected) return;
  try {
    const db = await mongoose.connect(MONGODB_URI);
    isConnected = db.connections[0].readyState;
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
  }
};

app.use(async (req, res, next) => {
  await connectDB();
  next();
});

// ─── Contact Intelligence Webhook ───────────────────────
const https = require('https');
const triggerIntelligence = () => {
  const target = process.env.NEXT_URL || 'https://fleet-topaz.vercel.app';
  if (!target.startsWith('https:')) return; // local dev skipped for safety

  const req = https.request(`${target}/api/contact-intelligence/process`, {
    method: 'GET',
    headers: { 'x-api-key': API_KEY }
  }, (res) => {
    console.log(`Webhook pinged successfully. Status: ${res.statusCode}`);
  });
  
  req.on('error', (e) => console.error('Failed to trigger contact intelligence:', e.message));
  req.end();
};

// ─── Routes ───────────────────────────────────────────

// Health check — no auth required
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Submit a single call log
app.post('/api/calls', authenticate, async (req, res) => {
  try {
    const { phoneNumber, contactName, callType, duration, timestamp, deviceId, employeeName } = req.body;
    if (!phoneNumber || !callType || !deviceId)
      return res.status(400).json({ error: 'Missing required fields: phoneNumber, callType, deviceId' });

    const callLog = new CallLog({
      phoneNumber,
      contactName:  contactName || 'Unknown',
      callType:     normalizeCallType(callType),
      duration:     duration || 0,
      timestamp:    new Date(timestamp || Date.now()),
      deviceId,
      employeeName: employeeName || 'Unknown'
    });

    await callLog.save();
    console.log(`📞 ${callType} | ${employeeName} | ${phoneNumber} | ${duration}s`);
    // trigger background processing in Next.js app
    triggerIntelligence();
    res.status(201).json({ success: true, message: 'Call log saved', id: callLog._id });
  } catch (err) {
    console.error('Error saving call:', err.message);

    // Duplicate call (same deviceId/number/timestamp/duration) — treat as success
    if (err && err.code === 11000) {
      return res.status(200).json({ success: true, message: 'Duplicate call log skipped' });
    }

    res.status(500).json({ error: 'Failed to save call log' });
  }
});

// Submit toggle status
app.post('/api/status', authenticate, async (req, res) => {
  try {
    const { deviceId, employeeName, status, timestamp, reason } = req.body;
    if (!deviceId || !status)
      return res.status(400).json({ error: 'Missing required fields: deviceId, status' });

    const toggleLog = new ToggleLog({
      deviceId,
      employeeName: employeeName || 'Unknown',
      status: status.toUpperCase(),
      reason: reason || undefined,
      timestamp: new Date(timestamp || Date.now())
    });

    await toggleLog.save();
    console.log(`🔌 Toggle ${status} | ${employeeName} | ${deviceId}`);
    res.status(201).json({ success: true, message: 'Status saved', id: toggleLog._id });
  } catch (err) {
    console.error('Error saving status:', err.message);
    res.status(500).json({ error: 'Failed to save status' });
  }
});

// Sync contacts from device
app.post('/api/contacts', authenticate, async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!Array.isArray(contacts) || contacts.length === 0)
      return res.status(400).json({ error: 'contacts must be a non-empty array' });

    const bulkOps = contacts.map(c => ({
      updateOne: {
        filter: { deviceId: c.deviceId, phoneNumber: c.phoneNumber },
        update: {
          $set: {
            employeeName: c.employeeName || 'Unknown',
            contactName:  c.contactName  || 'Unknown',
            timestamp:    new Date(Number(c.timestamp) || Date.now()),
            syncedAt:     new Date()
          }
        },
        upsert: true
      }
    }));

    await Contact.bulkWrite(bulkOps);
    console.log(`📇 Synced ${contacts.length} contacts`);
    res.status(201).json({ success: true, count: contacts.length });
  } catch (err) {
    console.error('Error syncing contacts:', err.message);
    res.status(500).json({ error: 'Failed to sync contacts' });
  }
});

// Batch submit call logs (for offline sync)
app.post('/api/calls/batch', authenticate, async (req, res) => {
  try {
    const { calls } = req.body;
    if (!Array.isArray(calls) || calls.length === 0)
      return res.status(400).json({ error: 'calls must be a non-empty array' });

    const docs = calls.map(c => ({
      phoneNumber:  c.phoneNumber,
      contactName:  c.contactName || 'Unknown',
      callType:     normalizeCallType(c.callType),
      duration:     c.duration || 0,
      timestamp:    new Date(c.timestamp || Date.now()),
      deviceId:     c.deviceId,
      employeeName: c.employeeName || 'Unknown'
    }));

    const result = await CallLog.insertMany(docs, { ordered: false });
    // trigger background processing in Next.js app
    triggerIntelligence();
    res.status(201).json({ success: true, savedCount: result.length });
  } catch (err) {
    console.error('Batch insert error:', err.message);

    // If all failures are duplicate-key errors, treat the batch as effectively successful.
    const writeErrors = err && err.writeErrors;
    const allDupes =
      Array.isArray(writeErrors) &&
      writeErrors.length > 0 &&
      writeErrors.every(e => e && e.code === 11000);

    if (err && err.code === 11000 || allDupes) {
      return res.status(200).json({ success: true, message: 'Duplicate call logs skipped in batch' });
    }

    res.status(500).json({ error: 'Failed to save call logs' });
  }
});

// Get call logs with filtering and pagination
app.get('/api/calls', authenticate, async (req, res) => {
  try {
    const {
      deviceId, employeeName, callType,
      from, to, phone,
      page  = 1,
      limit = 50
    } = req.query;

    const filter = {};
    if (deviceId)     filter.deviceId = deviceId;
    if (employeeName) filter.employeeName = new RegExp(employeeName, 'i');
    if (callType)     filter.callType = callType.toUpperCase();
    if (phone)        filter.phoneNumber = new RegExp(phone);
    if (from || to) {
      filter.timestamp = {};
      if (from) filter.timestamp.$gte = new Date(from);
      if (to)   filter.timestamp.$lte = new Date(to);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [total, calls] = await Promise.all([
      CallLog.countDocuments(filter),
      CallLog.find(filter).sort({ timestamp: -1 }).skip(skip).limit(parseInt(limit))
    ]);

    res.json({
      calls,
      pagination: {
        total,
        page:  parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('Error fetching calls:', err.message);
    res.status(500).json({ error: 'Failed to fetch call logs' });
  }
});

// Statistics endpoint
app.get('/api/stats', authenticate, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [total, todayCount, byType, byEmployee, avgDur] = await Promise.all([
      CallLog.countDocuments(),
      CallLog.countDocuments({ timestamp: { $gte: today } }),
      CallLog.aggregate([{ $group: { _id: '$callType', count: { $sum: 1 } } }]),
      CallLog.aggregate([
        { $group: { _id: '$employeeName', count: { $sum: 1 }, totalDuration: { $sum: '$duration' } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      CallLog.aggregate([
        { $match: { callType: { $in: ['INCOMING', 'OUTGOING'] } } },
        { $group: { _id: null, avg: { $avg: '$duration' } } }
      ])
    ]);

    const typeMap = byType.reduce((acc, t) => { acc[t._id] = t.count; return acc; }, {});

    res.json({
      totalCalls:      total,
      todayCalls:      todayCount,
      byType:          typeMap,
      topEmployees:    byEmployee,
      avgCallDuration: Math.round(avgDur[0]?.avg || 0)
    });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Employee list
app.get('/api/employees', authenticate, async (req, res) => {
  try {
    const list = await CallLog.aggregate([
      { $group: {
          _id: { employeeName: '$employeeName', deviceId: '$deviceId' },
          callCount: { $sum: 1 },
          lastCall:  { $max: '$timestamp' }
      }},
      { $sort: { lastCall: -1 } }
    ]);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

// Register location Mongo models early (DeviceLocationState) without mounting
// routes yet — FCM helpers used by those routes are defined later in this file.
require('./locationRoutes');

// ─── Enrollment Routes ─────────────────────────────────────────

// POST /api/enrollment/redeem — no auth, one-time code exchange
app.post('/api/enrollment/redeem', async (req, res) => {
  try {
    const { code, deviceId } = req.body;
    if (!code || !deviceId)
      return res.status(400).json({ error: 'Missing required fields: code, deviceId' });

    const enrollmentCode = await EnrollmentCode.findOne({ code });
    if (!enrollmentCode)
      return res.status(404).json({ error: 'Invalid enrollment code' });
    if (enrollmentCode.revoked)
      return res.status(410).json({ error: 'Enrollment code has been revoked' });
    if (enrollmentCode.usedAt)
      return res.status(410).json({ error: 'Enrollment code has already been used' });
    if (enrollmentCode.expiresAt && enrollmentCode.expiresAt < new Date())
      return res.status(410).json({ error: 'Enrollment code has expired' });

    const deviceToken = crypto.randomBytes(32).toString('hex');

    const enrollment = new DeviceEnrollment({
      deviceId,
      employeeId:   enrollmentCode.employeeId,
      employeeName: enrollmentCode.employeeName,
      role:         enrollmentCode.role,
      capabilities: enrollmentCode.capabilities,
      vehicle:      enrollmentCode.vehicle,
      companyId:    enrollmentCode.companyId,
      driverId:     enrollmentCode.driverId,
      deviceToken,
    });
    await enrollment.save();

    enrollmentCode.usedAt = new Date();
    await enrollmentCode.save();

    // Surface the device on fleet-map / route pickers immediately, even before
    // the first GPS fix arrives.
    if (enrollmentCode.capabilities?.locationTracking) {
      try {
        const DeviceLocationState = mongoose.models.DeviceLocationState;
        if (DeviceLocationState) {
          await DeviceLocationState.findOneAndUpdate(
            { deviceId },
            {
              $set: {
                deviceId,
                companyId: enrollmentCode.companyId,
                employeeId: enrollmentCode.employeeId,
                employeeName: enrollmentCode.employeeName,
                vehicle: enrollmentCode.vehicle,
                driverId: enrollmentCode.driverId,
                lastReceivedAt: new Date(),
                trackingStatus: 'ENROLLED',
              },
            },
            { upsert: true }
          );
        }
      } catch (stateErr) {
        console.error('DeviceLocationState seed (non-fatal):', stateErr.message);
      }
    }

    console.log(`📱 Device enrolled: ${deviceId} (${enrollmentCode.employeeName})`);

    // Never return a blank serverUrl — Android needs it for all later API calls.
    const resolvedServerUrl =
      enrollmentCode.serverUrl ||
      process.env.SERVER_URL ||
      process.env.BACKEND_URL ||
      `${req.protocol}://${req.get('host')}` ||
      '';

    res.json({
      employeeId:   enrollmentCode.employeeId,
      employeeName: enrollmentCode.employeeName,
      role:         enrollmentCode.role,
      capabilities: enrollmentCode.capabilities,
      vehicle:      enrollmentCode.vehicle || null,
      deviceToken,
      serverUrl:    String(resolvedServerUrl).replace(/\/$/, ''),
      apiKey:       enrollmentCode.apiKey    || process.env.API_KEY    || '',
      deviceId,
      webBaseUrl:   process.env.NEXT_URL || '',
    });
  } catch (err) {
    console.error('Enrollment redeem error:', err.message);
    res.status(500).json({ error: 'Failed to redeem enrollment code' });
  }
});

// POST /api/enrollment/codes — X-API-Key protected, creates a new one-time code
app.post('/api/enrollment/codes', authenticate, async (req, res) => {
  try {
    const {
      employeeName, role, capabilities, vehicle,
      companyId, employeeId, driverId, expiresInHours,
      serverUrl, apiKey,
    } = req.body;

    if (!employeeName || !role)
      return res.status(400).json({ error: 'Missing required fields: employeeName, role' });
    if (!['driver', 'employee'].includes(role))
      return res.status(400).json({ error: 'role must be driver or employee' });

    const code = crypto.randomBytes(16).toString('hex');

    const expiresAt = expiresInHours
      ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000)
      : undefined;

    const enrollmentCode = new EnrollmentCode({
      code,
      employeeId:   employeeId   || code,
      employeeName,
      role,
      capabilities: {
        callMonitoring:    capabilities?.callMonitoring    ?? false,
        locationTracking:  capabilities?.locationTracking  ?? false,
        expenseManagement: capabilities?.expenseManagement ?? false,
      },
      vehicle:   vehicle   || undefined,
      companyId: companyId || undefined,
      driverId:  driverId  || undefined,
      serverUrl: serverUrl || undefined,
      apiKey:    apiKey    || undefined,
      expiresAt,
    });

    await enrollmentCode.save();
    console.log(`🔑 Enrollment code created for ${employeeName} (${role})`);

    res.status(201).json({
      code,
      employeeName,
      role,
      expiresAt: expiresAt || null,
    });
  } catch (err) {
    console.error('Create enrollment code error:', err.message);
    res.status(500).json({ error: 'Failed to create enrollment code' });
  }
});

// ─── FCM Token Registration ───────────────────────────────────
app.post('/api/fcm-token', authenticate, async (req, res) => {
  try {
    const { deviceId, token } = req.body;
    if (!deviceId || !token)
      return res.status(400).json({ error: 'Missing required fields: deviceId, token' });

    await FcmToken.findOneAndUpdate(
      { deviceId },
      { token, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    console.log(`🔑 FCM token registered for device ${deviceId}`);
    res.status(200).json({ success: true, message: 'FCM token registered' });
  } catch (err) {
    console.error('Error saving FCM token:', err.message);
    res.status(500).json({ error: 'Failed to save FCM token' });
  }
});

// ─── FCM Wake-Up: send push to stale devices ─────────────────
const { GoogleAuth } = require('google-auth-library');
const fs   = require('fs');
const path = require('path');

function loadFirebaseServiceAccount() {
  const envJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (envJson && String(envJson).trim()) {
    return JSON.parse(envJson);
  }
  const saPath = path.join(__dirname, 'firebase-service-account.json');
  if (!fs.existsSync(saPath)) return null;
  return JSON.parse(fs.readFileSync(saPath, 'utf8'));
}

async function sendFcmDataToTokens(tokenDocs, projectId, accessToken, dataPayload) {
  let sent = 0;
  const errors = [];
  for (const tokenDoc of tokenDocs) {
    try {
      const fcmRes = await fetch(
        `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token: tokenDoc.token,
              data: dataPayload,
              android: {
                priority: 'high',
                ttl: '0s',
              },
            },
          }),
        }
      );

      if (fcmRes.ok) {
        sent++;
        console.log(`📩 FCM wake sent to device ${tokenDoc.deviceId}`);
      } else {
        const errBody = await fcmRes.text();
        errors.push({ deviceId: tokenDoc.deviceId, status: fcmRes.status, body: errBody });
        console.error(`❌ FCM send failed for ${tokenDoc.deviceId}: ${fcmRes.status} — ${errBody}`);
      }
    } catch (sendErr) {
      errors.push({ deviceId: tokenDoc.deviceId, error: sendErr.message });
    }
  }
  return { sent, errors };
}

app.all('/api/fcm-wake', authenticate, async (req, res) => {
  try {
    const staleHours = parseInt(req.query.hours, 10) || 12;
    const wakeAll =
      req.query.all === '1' || req.query.all === 'true' || req.query.all === 'yes';

    const serviceAccount = loadFirebaseServiceAccount();
    if (!serviceAccount) {
      return res.status(500).json({
        error:
          'Firebase credentials missing — set FIREBASE_SERVICE_ACCOUNT_JSON or add firebase-service-account.json',
      });
    }

    let tokens;
    let staleDeviceCount = 0;
    let mode = 'stale';

    if (wakeAll) {
      mode = 'all';
      tokens = await FcmToken.find({});
      if (tokens.length === 0) {
        return res.json({
          success: true,
          mode,
          message: 'No FCM tokens registered in the database.',
          staleDevices: 0,
          tokensFound: 0,
          sent: 0,
          errors: [],
        });
      }
    } else {
      const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);
      const staleDevices = await CallLog.aggregate([
        { $group: { _id: '$deviceId', lastCall: { $max: '$timestamp' } } },
        { $match: { lastCall: { $lt: cutoff } } },
      ]);

      if (staleDevices.length === 0) {
        const registeredTokens = await FcmToken.countDocuments();
        return res.json({
          success: true,
          mode,
          message: `No stale devices — every device has a call log within the last ${staleHours}h. Wake only targets “quiet” devices. ${registeredTokens} FCM token(s) on file. Use ?all=1 to ping all registered devices (testing).`,
          staleDevices: 0,
          tokensFound: 0,
          sent: 0,
          registeredTokens,
          errors: [],
        });
      }

      const deviceIds = staleDevices.map((d) => d._id);
      staleDeviceCount = deviceIds.length;
      tokens = await FcmToken.find({ deviceId: { $in: deviceIds } });

      if (tokens.length === 0) {
        return res.json({
          success: true,
          mode,
          message: `${staleDeviceCount} device(s) are stale (no recent logs) but none have an FCM token. Open the Android app with monitoring on so it can register.`,
          staleDevices: staleDeviceCount,
          tokensFound: 0,
          sent: 0,
          errors: [],
        });
      }
    }

    const auth = new GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });
    const client = await auth.getClient();
    const accessTokenRes = await client.getAccessToken();
    const accessToken = accessTokenRes.token;

    const projectId = serviceAccount.project_id;
    const { sent, errors } = await sendFcmDataToTokens(tokens, projectId, accessToken, { action: 'sync_now' });

    res.json({
      success: true,
      mode,
      staleDevices: mode === 'all' ? 0 : staleDeviceCount,
      tokensFound: tokens.length,
      sent,
      errors,
    });
  } catch (err) {
    console.error('FCM wake error:', err.message);
    res.status(500).json({ error: 'Failed to send FCM wake notifications' });
  }
});

// ─── Location Routes ──────────────────────────────────────────
const mountLocationRoutes = require('./locationRoutes');
mountLocationRoutes(app, {
  FcmToken,
  DeviceEnrollment,
  loadFirebaseServiceAccount,
  sendFcmDataToTokens,
  authenticate,
  GoogleAuth,
});

// ─── Android Caller Lookup Routes ──────────────────────────────
const mountCallerLookupRoutes = require('./callerLookupRoutes');
mountCallerLookupRoutes(app, {
  FcmToken,
  DeviceEnrollment,
  loadFirebaseServiceAccount,
  sendFcmDataToTokens,
  authenticate,
  GoogleAuth,
});

// ─── Export for Vercel ─────────────────────────────────────────
module.exports = app;
