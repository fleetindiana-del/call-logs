'use strict';

const mongoose = require('mongoose');

const JOB_STATUSES = [
  'requested',
  'running',
  'pausing',
  'paused',
  'stopping',
  'stopped',
  'completed',
  'failed',
];

const callerLookupJobSchema = new mongoose.Schema({
  companyId:            { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null },
  createdBy:            { type: String },
  deviceId:             { type: String, required: true, index: true },
  employeeName:         { type: String },
  status:               { type: String, enum: JOB_STATUSES, default: 'requested', index: true },
  requestedAction:      { type: String, enum: ['start', 'pause', 'resume', 'stop', null], default: 'start' },
  mobileProvider:       { type: String, required: true },
  seriesId:             { type: String, required: true },
  seriesPrefix:         { type: String, required: true },
  seriesLabel:          { type: String, required: true },
  startNumber:          { type: String, required: true },
  endNumber:            { type: String, required: true },
  batchSize:            { type: Number, required: true },
  delayMs:              { type: Number, default: 200 },
  workers:              { type: Number, default: 1 },
  lookupProviderId:     { type: String, required: true },
  maxRetries:           { type: Number, default: 2 },
  cursorIndex:          { type: Number, default: 0 },
  totalPlanned:         { type: Number, required: true },
  processed:            { type: Number, default: 0 },
  successful:           { type: Number, default: 0 },
  failed:               { type: Number, default: 0 },
  currentNumber:        { type: String, default: null },
  totalLookupDurationMs:{ type: Number, default: 0 },
  startedAt:            { type: Date, default: null },
  pausedAt:             { type: Date, default: null },
  completedAt:          { type: Date, default: null },
  stoppedAt:            { type: Date, default: null },
  lastHeartbeatAt:      { type: Date, default: null },
  errorMessage:         { type: String, default: null },
}, { timestamps: true });

callerLookupJobSchema.index({ deviceId: 1, status: 1, updatedAt: -1 });

const callerLookupResultSchema = new mongoose.Schema({
  jobId:            { type: mongoose.Schema.Types.ObjectId, ref: 'CallerLookupJob', required: true, index: true },
  companyId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null },
  deviceId:         { type: String, required: true, index: true },
  phoneNumber:      { type: String, required: true, index: true },
  callerName:       { type: String, default: null },
  lookupStatus:     { type: String, enum: ['found', 'not_found', 'error', 'skipped'], required: true },
  provider:         { type: String, required: true },
  lookupProviderId: { type: String, required: true },
  mobileProvider:   { type: String, required: true },
  seriesPrefix:     { type: String },
  kyc:              { type: mongoose.Schema.Types.Mixed, default: null },
  metadata:         { type: mongoose.Schema.Types.Mixed, default: null },
  rawResponse:      { type: mongoose.Schema.Types.Mixed, default: null },
  durationMs:       { type: Number, default: 0 },
  retryCount:       { type: Number, default: 0 },
  error:            { type: String, default: null },
  lookedUpAt:       { type: Date, default: Date.now, index: true },
}, { timestamps: true });

callerLookupResultSchema.index({ jobId: 1, phoneNumber: 1 }, { unique: true });
callerLookupResultSchema.index({ jobId: 1, lookedUpAt: -1 });

const callerLookupLogSchema = new mongoose.Schema({
  jobId:       { type: mongoose.Schema.Types.ObjectId, ref: 'CallerLookupJob', required: true, index: true },
  deviceId:    { type: String, required: true },
  level:       { type: String, enum: ['info', 'success', 'failure', 'error', 'retry', 'api'], required: true },
  message:     { type: String, required: true },
  phoneNumber: { type: String, default: null },
  durationMs:  { type: Number, default: null },
  details:     { type: mongoose.Schema.Types.Mixed, default: null },
  occurredAt:  { type: Date, default: Date.now },
}, { timestamps: { createdAt: true, updatedAt: false } });

callerLookupLogSchema.index({ jobId: 1, createdAt: -1 });

const CallerLookupJob = mongoose.models.CallerLookupJob
  || mongoose.model('CallerLookupJob', callerLookupJobSchema);
const CallerLookupResult = mongoose.models.CallerLookupResult
  || mongoose.model('CallerLookupResult', callerLookupResultSchema);
const CallerLookupLog = mongoose.models.CallerLookupLog
  || mongoose.model('CallerLookupLog', callerLookupLogSchema);

function normalizeNumber(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

function numberPlan(prefix, rawStart, rawEnd, rawBatchSize) {
  // Series catalogs (Android JioNumberSeriesCatalog + web series.ts) ship 4-digit
  // prefixes, so 4 is the real lower bound — a 5-digit floor rejected every job.
  if (!/^\d{4,9}$/.test(prefix)) throw new Error('seriesPrefix must contain 4–9 digits');
  const seriesStart = BigInt(prefix + '0'.repeat(10 - prefix.length));
  const seriesEnd = BigInt(prefix + '9'.repeat(10 - prefix.length));
  // Treat whitespace-only start/end as "not supplied" rather than as a bad number.
  const trimmedStart = String(rawStart == null ? '' : rawStart).trim();
  const trimmedEnd = String(rawEnd == null ? '' : rawEnd).trim();
  const startText = trimmedStart ? normalizeNumber(trimmedStart) : seriesStart.toString();
  const endText = trimmedEnd ? normalizeNumber(trimmedEnd) : seriesEnd.toString();
  if (!/^\d{10}$/.test(startText) || !/^\d{10}$/.test(endText)) {
    throw new Error('startNumber and endNumber must be 10-digit numbers');
  }
  let start = BigInt(startText);
  let end = BigInt(endText);
  if (start < seriesStart || start > seriesEnd || end < seriesStart || end > seriesEnd) {
    throw new Error(`Numbers must belong to series ${prefix}`);
  }
  if (end < start) throw new Error('endNumber must not be before startNumber');
  const batchSize = Math.min(Math.max(Number(rawBatchSize) || 200, 1), 100000);
  const total = Math.min(batchSize, Number(end - start + 1n));
  end = start + BigInt(total - 1);
  return { startNumber: start.toString(), endNumber: end.toString(), total };
}

module.exports = function mountCallerLookupRoutes(app, deps) {
  const {
    FcmToken,
    DeviceEnrollment,
    loadFirebaseServiceAccount,
    sendFcmDataToTokens,
    authenticate,
    GoogleAuth,
  } = deps;

  const authenticateDeviceToken = async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith('Bearer ')
        ? authHeader.slice(7)
        : req.headers['x-device-token'];
      if (!token) return res.status(401).json({ error: 'Missing device token' });
      const enrollment = await DeviceEnrollment.findOne({ deviceToken: token, revoked: { $ne: true } });
      if (!enrollment) return res.status(401).json({ error: 'Invalid or revoked device token' });
      req.enrollment = enrollment;
      next();
    } catch (err) {
      console.error('Caller lookup device auth error:', err.message);
      res.status(500).json({ error: 'Auth error' });
    }
  };

  const sendDeviceCommand = async (deviceId, action, jobId) => {
    try {
      const tokenDoc = await FcmToken.findOne({ deviceId });
      const serviceAccount = loadFirebaseServiceAccount();
      if (!tokenDoc || !serviceAccount) return false;
      const auth = new GoogleAuth({
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
      });
      const client = await auth.getClient();
      const { token } = await client.getAccessToken();
      const result = await sendFcmDataToTokens(
        [tokenDoc],
        serviceAccount.project_id,
        token,
        { action, jobId: String(jobId) }
      );
      return result.sent > 0;
    } catch (err) {
      console.error('Caller lookup FCM (non-fatal):', err.message);
      return false;
    }
  };

  async function createCallerLookupJob({
    enrollment,
    companyId,
    createdBy,
    mobileProvider = 'jio',
    seriesId,
    seriesPrefix,
    seriesLabel,
    startNumber,
    endNumber,
    batchSize = 200,
    delayMs = 200,
    workers = 1,
    lookupProviderId = 'android-call-log-cache',
    maxRetries = 2,
    source = 'dashboard',
  }) {
    if (!seriesId || !seriesPrefix || !seriesLabel) {
      throw Object.assign(new Error('seriesId, seriesPrefix, and seriesLabel are required'), { status: 400 });
    }
    const plan = numberPlan(seriesPrefix, startNumber, endNumber, batchSize);
    await CallerLookupJob.updateMany(
      { deviceId: enrollment.deviceId, status: { $in: ['requested', 'running', 'pausing', 'paused'] } },
      { $set: { status: 'stopped', requestedAction: null, stoppedAt: new Date() } }
    );

    const job = await CallerLookupJob.create({
      companyId: companyId || enrollment.companyId || null,
      createdBy: createdBy || enrollment.employeeName || enrollment.deviceId,
      deviceId: enrollment.deviceId,
      employeeName: enrollment.employeeName,
      status: 'requested',
      requestedAction: 'start',
      mobileProvider,
      seriesId,
      seriesPrefix,
      seriesLabel,
      startNumber: plan.startNumber,
      endNumber: plan.endNumber,
      batchSize: plan.total,
      delayMs: Math.min(Math.max(Number(delayMs) || 0, 0), 60000),
      workers: Math.min(Math.max(Number(workers) || 1, 1), 20),
      lookupProviderId,
      maxRetries: Math.min(Math.max(Number(maxRetries) || 0, 0), 5),
      totalPlanned: plan.total,
      currentNumber: plan.startNumber,
    });
    await CallerLookupLog.create({
      jobId: job._id,
      deviceId: enrollment.deviceId,
      level: 'info',
      message: source === 'android'
        ? `Job created on Android device (batch ${plan.total}); starting lookups`
        : 'Job requested from dashboard; waiting for Android device',
    });
    return job;
  }

  // Dashboard/admin creates the command. Android owns all number generation and lookup execution.
  app.post('/api/caller-lookup/jobs', authenticate, async (req, res) => {
    try {
      const {
        deviceId, companyId, createdBy, mobileProvider = 'jio',
        seriesId, seriesPrefix, seriesLabel, startNumber, endNumber,
        batchSize = 200, delayMs = 200, workers = 1,
        lookupProviderId = 'android-call-log-cache', maxRetries = 2,
      } = req.body;
      if (!deviceId) {
        return res.status(400).json({ error: 'deviceId is required' });
      }
      const enrollment = await DeviceEnrollment.findOne({ deviceId, revoked: { $ne: true } });
      if (!enrollment) return res.status(404).json({ error: 'Enrolled device not found' });
      if (companyId && enrollment.companyId && String(enrollment.companyId) !== String(companyId)) {
        return res.status(403).json({ error: 'Device does not belong to this company' });
      }

      const job = await createCallerLookupJob({
        enrollment,
        companyId,
        createdBy,
        mobileProvider,
        seriesId,
        seriesPrefix,
        seriesLabel,
        startNumber,
        endNumber,
        batchSize,
        delayMs,
        workers,
        lookupProviderId,
        maxRetries,
        source: 'dashboard',
      });
      const fcmSent = await sendDeviceCommand(deviceId, 'caller_lookup_start', job._id);
      res.status(201).json({ job, fcmSent });
    } catch (err) {
      console.error('Create caller lookup job error:', err.message);
      res.status(err.status || 400).json({ error: err.message || 'Failed to create caller lookup job' });
    }
  });

  app.post('/api/caller-lookup/jobs/:id/control', authenticate, async (req, res) => {
    try {
      const action = String(req.body.action || '').toLowerCase();
      if (!['pause', 'resume', 'stop'].includes(action)) {
        return res.status(400).json({ error: 'action must be pause, resume, or stop' });
      }
      const current = await CallerLookupJob.findById(req.params.id);
      if (!current) return res.status(404).json({ error: 'Job not found' });

      const status = action === 'pause' ? 'pausing' : action === 'stop' ? 'stopping' : 'requested';
      current.status = status;
      current.requestedAction = action;
      if (action === 'resume') current.pausedAt = null;
      await current.save();
      await CallerLookupLog.create({
        jobId: current._id,
        deviceId: current.deviceId,
        level: 'info',
        message: `${action} requested from dashboard`,
      });
      const fcmSent = await sendDeviceCommand(
        current.deviceId,
        action === 'resume' ? 'caller_lookup_resume' : 'caller_lookup_control',
        current._id
      );
      res.json({ job: current, fcmSent });
    } catch (err) {
      console.error('Caller lookup control error:', err.message);
      res.status(500).json({ error: 'Failed to control caller lookup job' });
    }
  });

  // Android device creates its own job (asks user for batch size on-device).
  app.post('/api/caller-lookup/device/jobs', authenticateDeviceToken, async (req, res) => {
    try {
      const {
        mobileProvider = 'jio',
        seriesId, seriesPrefix, seriesLabel, startNumber, endNumber,
        batchSize = 200, delayMs = 200, workers = 1,
        lookupProviderId = 'android-call-log-cache', maxRetries = 2,
      } = req.body;
      if (!Number.isFinite(Number(batchSize)) || Number(batchSize) < 1) {
        return res.status(400).json({ error: 'batchSize is required (e.g. 200)' });
      }
      const job = await createCallerLookupJob({
        enrollment: req.enrollment,
        companyId: req.enrollment.companyId || null,
        createdBy: req.enrollment.employeeName || req.enrollment.deviceId,
        mobileProvider,
        seriesId,
        seriesPrefix,
        seriesLabel,
        startNumber,
        endNumber,
        batchSize,
        delayMs,
        workers,
        lookupProviderId,
        maxRetries,
        source: 'android',
      });
      res.status(201).json({ job });
    } catch (err) {
      console.error('Device create caller lookup job error:', err.message);
      res.status(err.status || 400).json({ error: err.message || 'Failed to create caller lookup job' });
    }
  });

  app.post('/api/caller-lookup/device/jobs/:id/control', authenticateDeviceToken, async (req, res) => {
    try {
      const action = String(req.body.action || '').toLowerCase();
      if (!['pause', 'resume', 'stop'].includes(action)) {
        return res.status(400).json({ error: 'action must be pause, resume, or stop' });
      }
      const current = await CallerLookupJob.findOne({
        _id: req.params.id,
        deviceId: req.enrollment.deviceId,
      });
      if (!current) return res.status(404).json({ error: 'Job not found' });

      const status = action === 'pause' ? 'pausing' : action === 'stop' ? 'stopping' : 'requested';
      current.status = status;
      current.requestedAction = action;
      if (action === 'resume') current.pausedAt = null;
      await current.save();
      await CallerLookupLog.create({
        jobId: current._id,
        deviceId: current.deviceId,
        level: 'info',
        message: `${action} requested from Android device`,
      });
      res.json({ job: current });
    } catch (err) {
      console.error('Device caller lookup control error:', err.message);
      res.status(500).json({ error: 'Failed to control caller lookup job' });
    }
  });

  // Polling fallback for missed FCM. Also supports restart/resume after process death or reboot.
  app.get('/api/caller-lookup/device/jobs', authenticateDeviceToken, async (req, res) => {
    try {
      const jobs = await CallerLookupJob.find({
        deviceId: req.enrollment.deviceId,
        status: { $in: ['requested', 'running', 'pausing', 'stopping'] },
      }).sort({ createdAt: 1 }).limit(10);
      res.json({ jobs });
    } catch (err) {
      res.status(500).json({ error: 'Failed to get caller lookup jobs' });
    }
  });

  app.get('/api/caller-lookup/device/jobs/latest', authenticateDeviceToken, async (req, res) => {
    try {
      const job = await CallerLookupJob.findOne({ deviceId: req.enrollment.deviceId })
        .sort({ updatedAt: -1 });
      res.json({ job: job || null });
    } catch (err) {
      res.status(500).json({ error: 'Failed to get latest caller lookup job' });
    }
  });

  app.get('/api/caller-lookup/device/jobs/:id', authenticateDeviceToken, async (req, res) => {
    const job = await CallerLookupJob.findOne({
      _id: req.params.id,
      deviceId: req.enrollment.deviceId,
    });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ job });
  });

  app.post('/api/caller-lookup/device/jobs/:id/status', authenticateDeviceToken, async (req, res) => {
    try {
      const allowed = ['running', 'paused', 'stopped', 'completed', 'failed'];
      const status = String(req.body.status || '').toLowerCase();
      if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
      const set = {
        status,
        requestedAction: null,
        lastHeartbeatAt: new Date(),
      };
      if (status === 'running' && !req.body.startedAt) set.startedAt = new Date();
      if (req.body.startedAt) set.startedAt = new Date(req.body.startedAt);
      if (status === 'paused') set.pausedAt = new Date();
      if (status === 'stopped') set.stoppedAt = new Date();
      if (status === 'completed') set.completedAt = new Date();
      if (req.body.errorMessage) set.errorMessage = req.body.errorMessage;
      const job = await CallerLookupJob.findOneAndUpdate(
        { _id: req.params.id, deviceId: req.enrollment.deviceId },
        { $set: set },
        { new: true }
      );
      if (!job) return res.status(404).json({ error: 'Job not found' });
      res.json({ job });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update job status' });
    }
  });

  app.post('/api/caller-lookup/device/jobs/:id/progress', authenticateDeviceToken, async (req, res) => {
    try {
      const numericFields = [
        'cursorIndex', 'processed', 'successful', 'failed',
        'totalLookupDurationMs', 'totalPlanned',
      ];
      const set = { lastHeartbeatAt: new Date() };
      for (const key of numericFields) {
        if (Number.isFinite(Number(req.body[key]))) set[key] = Number(req.body[key]);
      }
      if (req.body.currentNumber !== undefined) set.currentNumber = req.body.currentNumber || null;
      const job = await CallerLookupJob.findOneAndUpdate(
        { _id: req.params.id, deviceId: req.enrollment.deviceId },
        { $set: set },
        { new: true }
      );
      if (!job) return res.status(404).json({ error: 'Job not found' });
      res.json({ success: true, job });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update job progress' });
    }
  });

  app.post('/api/caller-lookup/device/jobs/:id/results', authenticateDeviceToken, async (req, res) => {
    try {
      const job = await CallerLookupJob.findOne({
        _id: req.params.id,
        deviceId: req.enrollment.deviceId,
      });
      if (!job) return res.status(404).json({ error: 'Job not found' });
      const results = Array.isArray(req.body.results) ? req.body.results : [];
      if (!results.length) return res.status(400).json({ error: 'results must be non-empty' });
      const operations = results.slice(0, 500).map(result => ({
        updateOne: {
          filter: { jobId: job._id, phoneNumber: normalizeNumber(result.phoneNumber) },
          update: {
            $set: {
              companyId: job.companyId,
              deviceId: job.deviceId,
              phoneNumber: normalizeNumber(result.phoneNumber),
              callerName: result.callerName || null,
              lookupStatus: result.lookupStatus || 'not_found',
              provider: result.provider || job.lookupProviderId,
              lookupProviderId: result.lookupProviderId || job.lookupProviderId,
              mobileProvider: job.mobileProvider,
              seriesPrefix: job.seriesPrefix,
              kyc: result.kyc || null,
              metadata: result.metadata || null,
              rawResponse: result.rawResponse || null,
              durationMs: Number(result.durationMs) || 0,
              retryCount: Number(result.retryCount) || 0,
              error: result.error || null,
              lookedUpAt: result.lookedUpAt ? new Date(result.lookedUpAt) : new Date(),
            },
          },
          upsert: true,
        },
      }));
      await CallerLookupResult.bulkWrite(operations, { ordered: false });
      res.json({ success: true, accepted: operations.length });
    } catch (err) {
      console.error('Caller lookup results error:', err.message);
      res.status(500).json({ error: 'Failed to store caller lookup results' });
    }
  });

  app.post('/api/caller-lookup/device/jobs/:id/logs', authenticateDeviceToken, async (req, res) => {
    try {
      const job = await CallerLookupJob.findOne({
        _id: req.params.id,
        deviceId: req.enrollment.deviceId,
      });
      if (!job) return res.status(404).json({ error: 'Job not found' });
      const logs = Array.isArray(req.body.logs) ? req.body.logs : [];
      if (!logs.length) return res.status(400).json({ error: 'logs must be non-empty' });
      const docs = logs.slice(0, 500).map(log => ({
        jobId: job._id,
        deviceId: job.deviceId,
        level: log.level || 'info',
        message: String(log.message || ''),
        phoneNumber: log.phoneNumber || null,
        durationMs: log.durationMs == null ? null : Number(log.durationMs),
        details: log.details || null,
        occurredAt: log.occurredAt ? new Date(log.occurredAt) : new Date(),
      }));
      await CallerLookupLog.insertMany(docs, { ordered: false });
      res.json({ success: true, accepted: docs.length });
    } catch (err) {
      res.status(500).json({ error: 'Failed to store caller lookup logs' });
    }
  });
};

