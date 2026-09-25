/**
 * Simple in-memory sliding-window rate limiter.
 * Keyed by session user ID (falls back to IP).
 *
 * Usage:
 *   const limiter = createRateLimiter({ windowMs: 60000, max: 5, message: '...' });
 *   router.post('/send', limiter, handler);
 */

function createRateLimiter({ windowMs = 60000, max = 10, message = 'Too many requests, please slow down.' } = {}) {
    const hits = new Map(); // key → [timestamp, ...]

    // Prune old entries every windowMs
    setInterval(() => {
        const cutoff = Date.now() - windowMs;
        for (const [key, times] of hits) {
            const trimmed = times.filter(t => t > cutoff);
            if (trimmed.length === 0) hits.delete(key);
            else hits.set(key, trimmed);
        }
    }, windowMs).unref();

    return function rateLimitMiddleware(req, res, next) {
        const key = req.session?.user?.id ? `u:${req.session.user.id}` : `ip:${req.ip}`;
        const now = Date.now();
        const cutoff = now - windowMs;

        let times = (hits.get(key) || []).filter(t => t > cutoff);
        times.push(now);
        hits.set(key, times);

        if (times.length > max) {
            return res.status(429).json({ success: false, message });
        }
        next();
    };
}

module.exports = { createRateLimiter };
