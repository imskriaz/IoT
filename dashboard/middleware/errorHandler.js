function captureRawBody(req, _res, buf, encoding) {
    if (!buf || !buf.length) return;
    req.rawBody = buf.toString(encoding || 'utf8');
}

function buildRawBodyPreview(rawBody, maxLength = 160) {
    const normalized = String(rawBody || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.length > maxLength
        ? `${normalized.slice(0, maxLength)}...`
        : normalized;
}

function buildSafeRawBodyPreview(rawBody, maxLength = 160) {
    const preview = buildRawBodyPreview(rawBody, maxLength);
    if (!preview) return '';
    // SEC-10: redact secret-bearing fields in BOTH quoted (JSON) and unquoted
    // (form-encoded / bare) shapes, plus message-like content fields that can
    // carry personal SMS text into log files.
    const keys = 'password|pass|pwd|token|secret|api[_-]?key|authorization|cookie|session|csrf|otp|totp|pin|ssid|psk|credential|message|text|content';
    let safe = preview.replace(
        new RegExp(`((?:${keys})["']?\\s*[=:]\\s*)(["'])(?:\\\\.|(?!\\2).)*\\2`, 'gi'),
        '$1$2[REDACTED]$2'
    );
    // Form-encoded / unquoted values: key=value&... or {"key":value
    safe = safe.replace(
        new RegExp(`((?:${keys})(?:%[0-9A-Fa-f]{2}|\\s|\\t)*[=:]\\s*)([^&,"'\\s}]*)`, 'gi'),
        '$1[REDACTED]'
    );
    return safe;
}

function createErrorHandler(logger) {
    return (err, req, res, _next) => {
        try {
            const isApiRequest = req.originalUrl?.startsWith('/api');
            const isJsonParseError = err?.type === 'entity.parse.failed';
            const statusCode = err.status || err.statusCode || (isJsonParseError ? 400 : 500);
            const message = process.env.NODE_ENV === 'production'
                ? 'Something went wrong!'
                : (isJsonParseError ? 'Invalid JSON body' : err.message);

            if (isJsonParseError) {
                logger.warn('Invalid JSON body', {
                    url: req.url,
                    method: req.method,
                    ip: req.ip,
                    contentType: req.get?.('content-type') || req.headers?.['content-type'],
                    contentLength: req.get?.('content-length') || req.headers?.['content-length'],
                    bodyLength: req.rawBody ? String(req.rawBody).length : 0,
                    bodyPreview: buildSafeRawBodyPreview(req.rawBody)
                });
            } else {
                logger.error(`Unhandled error: ${err.message}`, {
                    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
                    url: req.url,
                    method: req.method,
                    ip: req.ip
                });
            }

            if (isApiRequest) {
                return res.status(statusCode).json({
                    success: false,
                    message
                });
            }

            return res.status(statusCode).render('pages/404', {
                title: 'Server Error',
                message,
                layout: 'layouts/main'
            });
        } catch (error) {
            logger.error('Error handler failed:', error);
            return res.status(500).send('Server Error');
        }
    };
}

module.exports = {
    buildRawBodyPreview,
    buildSafeRawBodyPreview,
    captureRawBody,
    createErrorHandler
};
