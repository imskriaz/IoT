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

function createErrorHandler(logger) {
    return (err, req, res, next) => {
        if (res.headersSent) {
            return typeof next === 'function' ? next(err) : undefined;
        }

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
                    bodyPreview: buildRawBodyPreview(req.rawBody)
                });
            } else {
                logger.error(`Unhandled error: ${err.message}`, {
                    stack: err.stack,
                    url: req.url,
                    method: req.method,
                    ip: req.ip,
                    body: req.body
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
            if (res.headersSent) {
                return typeof next === 'function' ? next(error) : undefined;
            }
            return res.status(500).send('Server Error');
        }
    };
}

module.exports = {
    buildRawBodyPreview,
    captureRawBody,
    createErrorHandler
};
