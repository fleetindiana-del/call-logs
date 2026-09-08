'use strict';

const mongoose = require('mongoose');

// ─── Location Schemas ──────────────────────────────────────────

const locationSessionSchema = new mongoose.Schema({
  sessionId:    { type: String, required: true, unique: true },
  deviceId:     { type: String, required: true },
  employeeId:   { type: String },
  vehicleId:    { type: String },
  companyId:    { type: String },
  startedAt:    { type: Date },
  stoppedAt:    { type: Date },
  status:       { type: String, enum: ['ACTIVE', 'COMPLETED', 'INTERRUPTED'], default: 'ACTIVE' },
  totalPoints:  { type: Number, default: 0 },
  firstPointAt: { type: Date },
  lastPointAt:  { type: Date },
  lastUploadAt: { type: Date },
  driverId:     { type: String },
}, { timestamps: true });

locationSessionSchema.index({ deviceId: 1, startedAt: -1 });
locationSessionSchema.index({ driverId: 1, startedAt: -1 });
locationSessionSchema.index({ companyId: 1, startedAt: -1 });

const LocationSession = mongoose.model('LocationSession', locationSessionSchema);

const locationPointSchema = new mongoose.Schema({
  pointId:              { type: String, required: true },
  sessionId:            { type: String },
  deviceId:             { type: String, required: true },
  companyId:            { type: String },
  driverId:             { type: String },
  employeeId:           { type: String },
  sequenceNumber:       { type: Number },
  latitude:             { type: Number, required: true },
  longitude:            { type: Number, required: true },
  accuracyMeters:       { type: Number },
  speedMetersPerSecond: { type: Number },
  bearingDegrees:       { type: Number },
  altitudeMeters:       { type: Number },
  recordedAt:           { type: Date },
  savedAt:              { type: Date, default: Date.now },
  batteryPercent:       { type: Number },
  provider:             { type: String },
  isMockLocation:       { type: Boolean, default: false },
});

locationPointSchema.index({ deviceId: 1, pointId: 1 }, { unique: true });
locationPointSchema.index({ sessionId: 1, sequenceNumber: 1 });
locationPointSchema.index({ deviceId: 1, recordedAt: -1 });
locationPointSchema.index({ driverId: 1, recordedAt: -1 });

const LocationPoint = mongoose.model('LocationPoint', locationPointSchema);

const deviceLocationStateSchema = new mongoose.Schema({
  deviceId:          { type: String, required: true, unique: true },
  latestCoordinates: { lat: Number, lng: Number },
  latestAccuracy:    { type: Number },
  latestSpeed:       { type: Number },
  lastRecordedAt:    { type: Date },
  lastReceivedAt:    { type: Date },
  trackingStatus:    { type: String },
  permissionStatus:  { type: String },
  gpsEnabled:        { type: Boolean },
  batteryPercent:    { type: Number },
  pendingPoints:     { type: Number },
  lastUploadAt:      { type: Date },
  appVersion:        { type: String },
  driverId:          { type: String },
  companyId:         { type: String },
  employeeId:        { type: String },
  employeeName:      { type: String },
  vehicle:           { id: String, registration: String },
}, { timestamps: true });

const DeviceLocationState = mongoose.model('DeviceLocationState', deviceLocationStateSchema);

const locationCommandSchema = new mongoose.Schema({
  deviceId:  { type: String, required: true },
  type:      {
    type: String,
    enum: ['location_upload', 'location_latest', 'location_live_mode', 'location_stop_live_mode', 'location_start_tracking', 'location_stop_tracking'],
    required: true,
  },
  status: {
    type: String,
    enum: ['REQUESTED', 'DELIVERED', 'UPLOADING', 'COMPLETED', 'EXPIRED', 'FAILED'],
    default: 'REQUESTED',
  },
  sessionId: { type: String },
  fromTime:  { type: Date },
  toTime:    { type: Date },
  expiresAt: { type: Date },
  error:     { type: String },
}, { timestamps: true });

locationCommandSchema.index({ deviceId: 1, status: 1 });

const LocationCommand = mongoose.model('LocationCommand', locationCommandSchema);

// ─── Mount Function ────────────────────────────────────────────

module.exports = function mountLocationRoutes(app, deps) {
  const {
    FcmToken,
    DeviceEnrollment,
    loadFirebaseServiceAccount,
    sendFcmDataToTokens,
    authenticate,
    GoogleAuth,
  } = deps;

  const API_KEY = process.env.API_KEY || 'change-this-key';

  // ─── Device-token auth ───────────────────────────────────────
  // Authorization: Bearer <deviceToken>  OR  X-Device-Token: <deviceToken>
  const authenticateDeviceToken = async (req, res, next) => {
    try {
      let token = null;
      const authHeader = req.headers['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
      if (!token) token = req.headers['x-device-token'] || null;
      if (!token) return res.status(401).json({ error: 'Missing device token' });

      const enrollment = await DeviceEnrollment.findOne({ deviceToken: token, revoked: { $ne: true } });
      if (!enrollment) return res.status(401).json({ error: 'Invalid or revoked device token' });

      req.enrollment = enrollment;
      next();
    } catch (err) {
      console.error('Device token auth error:', err.message);
      res.status(500).json({ error: 'Auth error' });
    }
  };

  // Accepts API-key (admin/dashboard) OR device token (own device only)
  const authenticateDeviceOrAdmin = async (req, res, next) => {
    const key = req.headers['x-api-key'];
    if (API_KEY && key === API_KEY) {
      req.isAdmin = true;
      return next();
    }
    return authenticateDeviceToken(req, res, next);
  };

  // ─── POST /api/location/device/register ─────────────────────
  // Device calls this on startup to refresh metadata / appVersion
  app.post('/api/location/device/register', authenticateDeviceToken, async (req, res) => {
    try {
      const { appVersion, trackingStatus, permissionStatus, gpsEnabled, batteryPercent } = req.body;
      const deviceId = req.enrollment.deviceId;

      const setFields = {
        deviceId,
        lastReceivedAt: new Date(),
        employeeId:     req.enrollment.employeeId,
        employeeName:   req.enrollment.employeeName,
        companyId:      req.enrollment.companyId,
        vehicle:        req.enrollment.vehicle,
      };
      if (appVersion       !== undefined) setFields.appVersion       = appVersion;
      if (trackingStatus   !== undefined) setFields.trackingStatus   = trackingStatus;
      if (permissionStatus !== undefined) setFields.permissionStatus = permissionStatus;
      if (gpsEnabled       !== undefined) setFields.gpsEnabled       = gpsEnabled;
      if (batteryPercent   !== undefined) setFields.batteryPercent   = batteryPercent;

      await DeviceLocationState.findOneAndUpdate(
        { deviceId },
        { $set: setFields },
        { upsert: true, new: true }
      );

      res.json({ success: true, deviceId });
    } catch (err) {
      console.error('Device register error:', err.message);
      res.status(500).json({ error: 'Failed to register device' });
    }
  });

  // ─── POST /api/location/batch ────────────────────────────────
  // Upload a batch of location points; upsert by (deviceId, pointId).
  app.post('/api/location/batch', authenticateDeviceToken, async (req, res) => {
    try {
      const { deviceId, sessionId, points } = req.body;
      if (!Array.isArray(points) || points.length === 0)
        return res.status(400).json({ error: 'points must be a non-empty array' });

      const resolvedDeviceId  = deviceId || req.enrollment.deviceId;
      const acceptedPointIds  = [];
      const duplicatePointIds = [];
      const rejected          = [];

      for (const pt of points) {
        if (!pt.pointId || pt.latitude == null || pt.longitude == null) {
          rejected.push({ pointId: pt.pointId || null, reason: 'missing required fields' });
          continue;
        }
        try {
          const doc = {
            pointId:              pt.pointId,
            sessionId:            pt.sessionId || sessionId,
            deviceId:             resolvedDeviceId,
            companyId:            req.enrollment.companyId,
            driverId:             req.enrollment.driverId,
            employeeId:           req.enrollment.employeeId,
            sequenceNumber:       pt.sequenceNumber,
            latitude:             pt.latitude,
            longitude:            pt.longitude,
            accuracyMeters:       pt.accuracyMeters,
            speedMetersPerSecond: pt.speedMetersPerSecond,
            bearingDegrees:       pt.bearingDegrees,
            altitudeMeters:       pt.altitudeMeters,
            recordedAt:           pt.recordedAt ? new Date(pt.recordedAt) : new Date(),
            savedAt:              new Date(),
            batteryPercent:       pt.batteryPercent,
            provider:             pt.provider,
            isMockLocation:       pt.isMockLocation || false,
          };
          const opResult = await LocationPoint.updateOne(
            { deviceId: resolvedDeviceId, pointId: pt.pointId },
            { $setOnInsert: doc },
            { upsert: true }
          );
          if (opResult.upsertedCount > 0) {
            acceptedPointIds.push(pt.pointId);
          } else {
            duplicatePointIds.push(pt.pointId);
          }
        } catch (ptErr) {
          if (ptErr.code === 11000) {
            duplicatePointIds.push(pt.pointId);
          } else {
            rejected.push({ pointId: pt.pointId, reason: ptErr.message });
          }
        }
      }

      // Update session aggregate fields (upsert so routes appear even if
      // the device never called /sessions/upsert).
      if (sessionId && acceptedPointIds.length > 0) {
        const acceptedPts = points.filter(p => acceptedPointIds.includes(p.pointId));
        const times = acceptedPts
          .map(p => p.recordedAt ? new Date(p.recordedAt) : null)
          .filter(Boolean)
          .sort((a, b) => a - b);

        const sessionUpdate = {
          $inc: { totalPoints: acceptedPointIds.length },
          $set: {
            lastUploadAt: new Date(),
            deviceId: resolvedDeviceId,
            companyId: req.enrollment.companyId,
            employeeId: req.enrollment.employeeId,
            driverId: req.enrollment.driverId,
          },
          $setOnInsert: {
            sessionId,
            status: 'ACTIVE',
            startedAt: times[0] || new Date(),
            vehicleId: req.enrollment.vehicle?.id,
          },
        };
        if (times.length > 0) {
          sessionUpdate.$min = { firstPointAt: times[0] };
          sessionUpdate.$max = { lastPointAt: times[times.length - 1] };
        }
        await LocationSession.updateOne({ sessionId }, sessionUpdate, { upsert: true });
      }

      // Update DeviceLocationState with the most-recent accepted point
      if (acceptedPointIds.length > 0) {
        const acceptedPts = points.filter(p => acceptedPointIds.includes(p.pointId));
        const latestPt = acceptedPts.reduce((best, pt) => {
          const t = pt.recordedAt ? new Date(pt.recordedAt).getTime() : 0;
          const bt = best?.recordedAt ? new Date(best.recordedAt).getTime() : 0;
          return t > bt ? pt : best;
        }, null);

        if (latestPt) {
          const stateSet = {
            deviceId:          resolvedDeviceId,
            latestCoordinates: { lat: latestPt.latitude, lng: latestPt.longitude },
            lastReceivedAt:    new Date(),
            lastUploadAt:      new Date(),
            // Always stamp enrollment identity so company-scoped fleet map sees the device.
            companyId:         req.enrollment.companyId,
            employeeId:        req.enrollment.employeeId,
            employeeName:      req.enrollment.employeeName,
            vehicle:           req.enrollment.vehicle,
            driverId:          req.enrollment.driverId,
            trackingStatus:    'TRACKING',
          };
          if (latestPt.accuracyMeters       != null) stateSet.latestAccuracy = latestPt.accuracyMeters;
          if (latestPt.speedMetersPerSecond != null) stateSet.latestSpeed    = latestPt.speedMetersPerSecond;
          if (latestPt.batteryPercent       != null) stateSet.batteryPercent = latestPt.batteryPercent;
          stateSet.lastRecordedAt = latestPt.recordedAt ? new Date(latestPt.recordedAt) : new Date();

          await DeviceLocationState.findOneAndUpdate(
            { deviceId: resolvedDeviceId },
            { $set: stateSet },
            { upsert: true }
          );
        }
      }

      // Close out fix-and-upload commands the device picked up (status UPLOADING)
      // but never reports COMPLETED for — a successful batch from that device is
      // the completion signal. Without this they hang at UPLOADING forever and
      // the fleet map can't tell "working" from "phone can't get a fix".
      if (acceptedPointIds.length > 0 || duplicatePointIds.length > 0) {
        try {
          await LocationCommand.updateMany(
            {
              deviceId: resolvedDeviceId,
              type: { $in: ['location_upload', 'location_latest'] },
              status: 'UPLOADING',
            },
            { $set: { status: 'COMPLETED' } }
          );
        } catch (cmdErr) {
          console.error('Command completion (non-fatal):', cmdErr.message);
        }
      }

      res.json({ acceptedPointIds, duplicatePointIds, rejected, hasMore: false });
    } catch (err) {
      console.error('Location batch error:', err.message);
      res.status(500).json({ error: 'Failed to process location batch' });
    }
  });

  // ─── POST /api/location/heartbeat ───────────────────────────
  app.post('/api/location/heartbeat', authenticateDeviceToken, async (req, res) => {
    try {
      const {
        deviceId, trackingStatus, permissionStatus,
        gpsEnabled, batteryPercent, pendingPoints, appVersion,
      } = req.body;
      const resolvedDeviceId = deviceId || req.enrollment.deviceId;

      const setFields = {
        deviceId: resolvedDeviceId,
        lastReceivedAt: new Date(),
        companyId: req.enrollment.companyId,
        employeeId: req.enrollment.employeeId,
        employeeName: req.enrollment.employeeName,
        vehicle: req.enrollment.vehicle,
        driverId: req.enrollment.driverId,
      };
      if (trackingStatus   !== undefined) setFields.trackingStatus   = trackingStatus;
      if (permissionStatus !== undefined) setFields.permissionStatus = permissionStatus;
      if (gpsEnabled       !== undefined) setFields.gpsEnabled       = gpsEnabled;
      if (batteryPercent   !== undefined) setFields.batteryPercent   = batteryPercent;
      if (pendingPoints    !== undefined) setFields.pendingPoints    = pendingPoints;
      if (appVersion       !== undefined) setFields.appVersion       = appVersion;

      await DeviceLocationState.findOneAndUpdate(
        { deviceId: resolvedDeviceId },
        { $set: setFields },
        { upsert: true }
      );

      res.json({ success: true });
    } catch (err) {
      console.error('Heartbeat error:', err.message);
      res.status(500).json({ error: 'Failed to update heartbeat' });
    }
  });

  // ─── GET /api/location/commands ─────────────────────────────
  // Returns pending (REQUESTED|DELIVERED) commands; marks REQUESTED → DELIVERED.
  app.get('/api/location/commands', authenticateDeviceToken, async (req, res) => {
    try {
      const deviceId = req.query.deviceId || req.enrollment.deviceId;

      const commands = await LocationCommand.find({
        deviceId,
        status: { $in: ['REQUESTED', 'DELIVERED'] },
        $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
      }).sort({ createdAt: 1 });

      const toDeliver = commands.filter(c => c.status === 'REQUESTED').map(c => c._id);
      if (toDeliver.length > 0) {
        await LocationCommand.updateMany(
          { _id: { $in: toDeliver } },
          { $set: { status: 'DELIVERED' } }
        );
        commands.forEach(c => { if (c.status === 'REQUESTED') c.status = 'DELIVERED'; });
      }

      res.json({ commands });
    } catch (err) {
      console.error('Get commands error:', err.message);
      res.status(500).json({ error: 'Failed to get commands' });
    }
  });

  // ─── POST /api/location/commands/:id/status ─────────────────
  app.post('/api/location/commands/:id/status', authenticateDeviceToken, async (req, res) => {
    try {
      const { status, error } = req.body;
      const update = { status };
      if (error) update.error = error;

      const command = await LocationCommand.findByIdAndUpdate(
        req.params.id,
        { $set: update },
        { new: true }
      );
      if (!command) return res.status(404).json({ error: 'Command not found' });
      res.json({ success: true, command });
    } catch (err) {
      console.error('Command status error:', err.message);
      res.status(500).json({ error: 'Failed to update command status' });
    }
  });

  // ─── POST /api/location/request-upload ──────────────────────
  // Admin endpoint: creates a location command and pings device via FCM.
  app.post('/api/location/request-upload', authenticate, async (req, res) => {
    try {
      const { deviceId, sessionId, fromTime, toTime, type: rawType } = req.body;
      if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

      const allowed = ['location_upload', 'location_latest', 'location_live_mode', 'location_stop_live_mode', 'location_start_tracking', 'location_stop_tracking'];
      const type = allowed.includes(rawType) ? rawType : 'location_upload';

      const cmdData = {
        deviceId,
        type,
        status:    'REQUESTED',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      };
      if (sessionId) cmdData.sessionId = sessionId;
      if (fromTime)  cmdData.fromTime  = new Date(fromTime);
      if (toTime)    cmdData.toTime    = new Date(toTime);

      const command = await LocationCommand.create(cmdData);

      // Best-effort FCM push — failure is non-fatal
      try {
        const tokenDoc = await FcmToken.findOne({ deviceId });
        if (tokenDoc) {
          const serviceAccount = loadFirebaseServiceAccount();
          if (serviceAccount) {
            const auth         = new GoogleAuth({
              credentials: serviceAccount,
              scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
            });
            const client       = await auth.getClient();
            const { token: at } = await client.getAccessToken();
            await sendFcmDataToTokens(
              [tokenDoc],
              serviceAccount.project_id,
              at,
              { action: type, commandId: command._id.toString() }
            );
          }
        }
      } catch (fcmErr) {
        console.error('FCM (non-fatal):', fcmErr.message);
      }

      res.json({ success: true, commandId: command._id, type });
    } catch (err) {
      console.error('Request upload error:', err.message);
      res.status(500).json({ error: 'Failed to create upload command' });
    }
  });

  // ─── GET /api/location/latest ────────────────────────────────
  // Admin: filter by companyId/deviceId/driverId.
  // Device token: own device only.
  app.get('/api/location/latest', authenticateDeviceOrAdmin, async (req, res) => {
    try {
      const filter = {};
      if (req.isAdmin) {
        if (req.query.companyId) filter.companyId = req.query.companyId;
        if (req.query.deviceId)  filter.deviceId  = req.query.deviceId;
        if (req.query.driverId)  filter.driverId  = req.query.driverId;
      } else {
        filter.deviceId = req.enrollment.deviceId;
      }
      const states = await DeviceLocationState.find(filter);
      res.json({ states });
    } catch (err) {
      console.error('Latest error:', err.message);
      res.status(500).json({ error: 'Failed to get latest states' });
    }
  });

  // ─── GET /api/location/history ───────────────────────────────
  // Query by sessionId OR deviceId + from/to range.
  app.get('/api/location/history', authenticate, async (req, res) => {
    try {
      const { sessionId, deviceId, from, to } = req.query;
      const limit = Math.min(parseInt(req.query.limit) || 1000, 5000);

      const filter = {};
      if (sessionId) filter.sessionId = sessionId;
      if (deviceId)  filter.deviceId  = deviceId;
      if (from || to) {
        filter.recordedAt = {};
        if (from) filter.recordedAt.$gte = new Date(from);
        if (to)   filter.recordedAt.$lte = new Date(to);
      }

      const points = await LocationPoint.find(filter)
        .sort({ sequenceNumber: 1 })
        .limit(limit);

      res.json({ points, count: points.length });
    } catch (err) {
      console.error('History error:', err.message);
      res.status(500).json({ error: 'Failed to get location history' });
    }
  });

  // ─── GET /api/location/sessions ─────────────────────────────
  app.get('/api/location/sessions', authenticate, async (req, res) => {
    try {
      const { deviceId, driverId, status, from, to } = req.query;
      const filter = {};
      if (deviceId) filter.deviceId = deviceId;
      if (driverId) filter.driverId = driverId;
      if (status)   filter.status   = status.toUpperCase();
      if (from || to) {
        filter.startedAt = {};
        if (from) filter.startedAt.$gte = new Date(from);
        if (to)   filter.startedAt.$lte = new Date(to);
      }
      const sessions = await LocationSession.find(filter).sort({ startedAt: -1 });
      res.json({ sessions });
    } catch (err) {
      console.error('Sessions error:', err.message);
      res.status(500).json({ error: 'Failed to get sessions' });
    }
  });

  // ─── POST /api/location/sessions/upsert ─────────────────────
  // Device reports session start / stop / interruption.
  app.post('/api/location/sessions/upsert', authenticateDeviceToken, async (req, res) => {
    try {
      const { sessionId, deviceId, employeeId, vehicleId, companyId, startedAt, stoppedAt, status, driverId } = req.body;
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

      const resolvedDeviceId = deviceId || req.enrollment.deviceId;
      const setFields = {
        sessionId,
        deviceId:   resolvedDeviceId,
        employeeId: employeeId || req.enrollment.employeeId,
        companyId:  companyId  || req.enrollment.companyId,
        driverId:   driverId   || req.enrollment.driverId,
      };
      if (vehicleId)                 setFields.vehicleId = vehicleId;
      else if (req.enrollment.vehicle?.id) setFields.vehicleId = req.enrollment.vehicle.id;
      if (status)    setFields.status    = status.toUpperCase();
      if (startedAt) setFields.startedAt = new Date(startedAt);
      if (stoppedAt) setFields.stoppedAt = new Date(stoppedAt);

      const session = await LocationSession.findOneAndUpdate(
        { sessionId },
        { $set: setFields },
        { upsert: true, new: true }
      );
      res.json({ success: true, session });
    } catch (err) {
      console.error('Session upsert error:', err.message);
      res.status(500).json({ error: 'Failed to upsert session' });
    }
  });
};
