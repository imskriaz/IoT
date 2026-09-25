const fs = require('fs');
const path = require('path');

const PUBLIC_ROOT = path.join(__dirname, '../public');

function sanitizeFileSegment(value) {
    return String(value || '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'capture';
}

function detectExtension(format = '', mimeType = '') {
    const token = String(format || mimeType || '').toLowerCase();
    if (token.includes('png')) return 'png';
    if (token.includes('webp')) return 'webp';
    if (token.includes('bmp')) return 'bmp';
    return 'jpg';
}

function parseCaptureMetadata(metadata = {}) {
    const faces = Array.isArray(metadata.faces) ? metadata.faces : [];
    const faceDetected = metadata.faceDetected ?? metadata.face_detected ?? faces.length > 0;
    const faceCount = metadata.faceCount ?? metadata.face_count ?? faces.length ?? 0;
    const recognizedLabel =
        metadata.recognizedLabel ??
        metadata.recognized_label ??
        metadata.match?.name ??
        metadata.recognition?.name ??
        null;
    const recognitionConfidence =
        metadata.recognitionConfidence ??
        metadata.recognition_confidence ??
        metadata.match?.confidence ??
        metadata.recognition?.confidence ??
        null;

    return {
        motionDetected: Boolean(metadata.motionDetected ?? metadata.motion_detected),
        faceDetected: Boolean(faceDetected),
        faceCount: Number.isFinite(Number(faceCount)) ? Number(faceCount) : 0,
        recognizedLabel: recognizedLabel ? String(recognizedLabel) : null,
        recognitionConfidence: recognitionConfidence == null ? null : Number(recognitionConfidence),
        captureType: String(metadata.captureType || metadata.capture_type || 'event'),
        source: String(metadata.source || 'mqtt')
    };
}

function normalizeCaptureRow(row) {
    let metadata = null;
    let tags = [];
    try {
        metadata = row.metadata ? JSON.parse(row.metadata) : null;
    } catch (_) {
        metadata = null;
    }
    try {
        tags = row.tags ? JSON.parse(row.tags) : [];
    } catch (_) {
        tags = [];
    }

    return {
        id: row.id,
        deviceId: row.device_id,
        webcamId: row.webcam_id,
        filename: row.filename,
        path: row.path,
        url: row.path,
        size: row.size,
        format: row.format,
        timestamp: row.timestamp,
        captureType: row.capture_type || 'event',
        source: row.source || 'mqtt',
        motionDetected: !!row.motion_detected,
        faceDetected: !!row.face_detected,
        faceCount: row.face_count || 0,
        recognizedLabel: row.recognized_label || null,
        recognitionConfidence: row.recognition_confidence ?? null,
        tags,
        metadata
    };
}

async function ensurePublicDir(relativeDir) {
    const absoluteDir = path.join(PUBLIC_ROOT, relativeDir);
    await fs.promises.mkdir(absoluteDir, { recursive: true });
    return absoluteDir;
}

async function saveCapture({
    db,
    deviceId,
    imageBase64,
    format,
    mimeType,
    webcamId = null,
    relativeDir = 'uploads/webcam',
    filenamePrefix = 'capture',
    tags = [],
    metadata = {}
}) {
    if (!db) throw new Error('Database not available');
    if (!deviceId) throw new Error('deviceId is required');
    if (!imageBase64) throw new Error('imageBase64 is required');

    const dir = await ensurePublicDir(relativeDir);
    const extension = detectExtension(format, mimeType);
    const filename = `${sanitizeFileSegment(filenamePrefix)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extension}`;
    const filePath = path.join(dir, filename);
    const buffer = Buffer.from(imageBase64, 'base64');

    await fs.promises.writeFile(filePath, buffer);

    const parsed = parseCaptureMetadata(metadata);
    const webPath = `/${relativeDir.replace(/\\/g, '/')}/${filename}`;
    const tagList = Array.isArray(tags) ? tags : [];
    const result = await db.run(
        `INSERT INTO webcam_captures
            (device_id, webcam_id, filename, path, size, format, tags,
             capture_type, motion_detected, face_detected, face_count,
             recognized_label, recognition_confidence, metadata, source, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
            deviceId,
            webcamId,
            filename,
            webPath,
            buffer.length,
            extension,
            JSON.stringify(tagList),
            parsed.captureType,
            parsed.motionDetected ? 1 : 0,
            parsed.faceDetected ? 1 : 0,
            parsed.faceCount,
            parsed.recognizedLabel,
            parsed.recognitionConfidence,
            JSON.stringify(metadata || {}),
            parsed.source
        ]
    );

    const row = await db.get(`SELECT * FROM webcam_captures WHERE id = ?`, [result.lastID]);
    return normalizeCaptureRow(row);
}

async function listCaptures({
    db,
    deviceId,
    limit = 50,
    faceDetected,
    motionDetected,
    recognized,
    captureType,
    source
}) {
    const conditions = [];
    const params = [];

    if (deviceId) {
        conditions.push('device_id = ?');
        params.push(deviceId);
    }
    if (captureType) {
        conditions.push('capture_type = ?');
        params.push(captureType);
    }
    if (source) {
        conditions.push('source = ?');
        params.push(source);
    }
    if (faceDetected === true) conditions.push('face_detected = 1');
    if (faceDetected === false) conditions.push('face_detected = 0');
    if (motionDetected === true) conditions.push('motion_detected = 1');
    if (motionDetected === false) conditions.push('motion_detected = 0');
    if (recognized === 'known') conditions.push("COALESCE(recognized_label, '') <> ''");
    if (recognized === 'unknown') conditions.push('face_detected = 1 AND COALESCE(recognized_label, \'\') = \'\'');

    const rows = await db.all(
        `SELECT *
         FROM webcam_captures
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY timestamp DESC
         LIMIT ?`,
        [...params, Math.min(Math.max(Number(limit) || 50, 1), 500)]
    );

    return rows.map(normalizeCaptureRow);
}

async function getCaptureSummary(db, deviceId) {
    const row = await db.get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN face_detected = 1 THEN 1 ELSE 0 END) AS faceDetected,
                SUM(CASE WHEN motion_detected = 1 THEN 1 ELSE 0 END) AS motionDetected,
                SUM(CASE WHEN COALESCE(recognized_label, '') <> '' THEN 1 ELSE 0 END) AS recognized
         FROM webcam_captures
         WHERE device_id = ?`,
        [deviceId]
    );

    return {
        total: row?.total || 0,
        faceDetected: row?.faceDetected || 0,
        motionDetected: row?.motionDetected || 0,
        recognized: row?.recognized || 0
    };
}

async function deleteCapture(db, identifier, deviceId = null) {
    let row = null;

    if (/^\d+$/.test(String(identifier))) {
        row = await db.get(
            `SELECT * FROM webcam_captures WHERE id = ? ${deviceId ? 'AND device_id = ?' : ''}`,
            deviceId ? [Number(identifier), deviceId] : [Number(identifier)]
        );
    } else {
        row = await db.get(
            `SELECT * FROM webcam_captures WHERE filename = ? ${deviceId ? 'AND device_id = ?' : ''}`,
            deviceId ? [identifier, deviceId] : [identifier]
        );
    }

    if (!row) return null;

    const relativePath = String(row.path || '').replace(/^\/+/, '');
    const absolutePath = path.join(PUBLIC_ROOT, relativePath);
    if (absolutePath.startsWith(PUBLIC_ROOT + path.sep) && fs.existsSync(absolutePath)) {
        await fs.promises.unlink(absolutePath).catch(() => {});
    }

    await db.run(`DELETE FROM webcam_captures WHERE id = ?`, [row.id]);
    return normalizeCaptureRow(row);
}

module.exports = {
    deleteCapture,
    getCaptureSummary,
    listCaptures,
    normalizeCaptureRow,
    saveCapture
};
