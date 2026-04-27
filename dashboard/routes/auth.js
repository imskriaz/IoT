const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { body, validationResult } = require('express-validator');
const logger = require('../utils/logger');

function parseUserAgent(ua) {
    if (!ua) return 'Unknown';
    if (/mobile/i.test(ua)) return 'Mobile Browser';
    if (/tablet|ipad/i.test(ua)) return 'Tablet Browser';
    if (/chrome/i.test(ua)) return 'Chrome Desktop';
    if (/firefox/i.test(ua)) return 'Firefox Desktop';
    if (/safari/i.test(ua)) return 'Safari Desktop';
    return 'Browser';
}

// Login page
router.get('/login', (req, res) => {
    // If already logged in, redirect to dashboard
    if (req.session.user) {
        return res.redirect('/dashboard');
    }
    
    res.render('pages/login', {
        title: 'Login',
        layout: false,
        error_msg: req.flash('error')
    });
});

router.get('/signup', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }

    res.render('pages/signup', {
        title: 'Create Account',
        layout: false,
        error_msg: req.flash('error'),
        success_msg: req.flash('success')
    });
});

router.post('/signup', [
    body('username').trim().notEmpty().withMessage('Username is required')
        .isLength({ min: 3, max: 30 }).withMessage('Username must be 3-30 characters')
        .matches(/^[a-zA-Z0-9_.-]+$/).withMessage('Username may only contain letters, numbers, _ . -'),
    body('name').trim().notEmpty().isLength({ max: 100 }).withMessage('Name is required'),
    body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('password_confirm').custom((value, { req: request }) => value === request.body.password).withMessage('Passwords do not match')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            req.flash('error', errors.array()[0].msg);
            return res.redirect('/auth/signup');
        }

        const db = req.app.locals.db;
        const { username, name, email, password } = req.body;
        const existingUser = await db.get(
            `SELECT id FROM users WHERE username = ? OR email = ?`,
            [username, email]
        );
        if (existingUser) {
            req.flash('error', 'Username or email already exists');
            return res.redirect('/auth/signup');
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await db.run(
            `INSERT INTO users (username, password, name, email, role, is_active, must_change_password)
             VALUES (?, ?, ?, ?, 'viewer', 1, 0)`,
            [username, hashedPassword, name, email]
        );

        req.flash('success', 'Account created. Please log in.');
        return res.redirect('/auth/login');
    } catch (error) {
        logger.error('POST /auth/signup error:', error);
        req.flash('error', 'Registration failed');
        return res.redirect('/auth/signup');
    }
});

// Login handler
router.post('/login', [
    body('username').trim().notEmpty().withMessage('Username is required'),
    body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            req.flash('error', errors.array()[0].msg);
            return res.redirect('/auth/login');
        }

        const { username, password } = req.body;
        const db = req.app.locals.db;

        // Find user
        const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);

        if (!user) {
            logger.warn(`Failed login attempt for username: ${username}`);
            // Audit log
            await req.app.locals.db.run(
                `INSERT INTO login_audit (username, user_id, success, ip, user_agent, reason) VALUES (?, ?, 0, ?, ?, ?)`,
                [username, null, req.ip, req.get('user-agent')?.substring(0, 200) || null, 'unknown_user']
            ).catch(() => {}); // non-fatal
            req.flash('error', 'Invalid username or password');
            return res.redirect('/auth/login');
        }

        if (!Number(user.is_active)) {
            logger.warn(`Inactive user login attempt for username: ${username}`);
            await req.app.locals.db.run(
                `INSERT INTO login_audit (username, user_id, success, ip, user_agent, reason) VALUES (?, ?, 0, ?, ?, ?)`,
                [username, user.id, req.ip, req.get('user-agent')?.substring(0, 200) || null, 'inactive_user']
            ).catch(() => {});
            req.flash('error', 'This account is inactive');
            return res.redirect('/auth/login');
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            logger.warn(`Failed login attempt for username: ${username}`);
            await req.app.locals.db.run(
                `INSERT INTO login_audit (username, user_id, success, ip, user_agent, reason) VALUES (?, ?, 0, ?, ?, ?)`,
                [username, user.id, req.ip, req.get('user-agent')?.substring(0, 200) || null, 'bad_password']
            ).catch(() => {});
            req.flash('error', 'Invalid username or password');
            return res.redirect('/auth/login');
        }

        // Update last login
        await db.run(
            'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
            [user.id]
        );

        // Check if this role requires 2FA
        const twoFaSetting = await db.get(`SELECT value FROM settings WHERE key = 'require_2fa_roles'`).catch(() => null);
        const required2faRoles = twoFaSetting ? (() => { try { return JSON.parse(twoFaSetting.value); } catch { return []; } })() : [];
        const roleRequires2fa = required2faRoles.includes(user.role);

        // If 2FA is enabled, redirect to TOTP challenge before creating full session
        if (user.totp_enabled && user.totp_secret) {
            req.session.pendingUserId = user.id;
            return res.redirect('/auth/2fa');
        }

        // If role requires 2FA but user hasn't set it up, force setup now
        if (roleRequires2fa && !user.totp_enabled) {
            // Regenerate session and create a limited session flagged for 2FA setup
            await new Promise((resolve, reject) =>
                req.session.regenerate(err => err ? reject(err) : resolve())
            );
            req.session.user = {
                id: user.id, username: user.username, name: user.name || user.username,
                email: user.email, role: user.role, mustChangePassword: !!user.must_change_password,
                must_setup_2fa: true
            };
            return res.redirect('/auth/setup-2fa-required');
        }

        // Regenerate session ID before writing credentials (session fixation protection)
        await new Promise((resolve, reject) =>
            req.session.regenerate(err => err ? reject(err) : resolve())
        );

        let userTheme = 'light';
        try {
            const prefs = JSON.parse(user.preferences || '{}');
            if (prefs.theme === 'dark') userTheme = 'dark';
        } catch (_) {}

        req.session.user = {
            id: user.id,
            username: user.username,
            name: user.name || user.username,
            email: user.email,
            role: user.role,
            mustChangePassword: !!user.must_change_password,
            theme: userTheme
        };

        logger.info(`User logged in: ${username}`);
        await req.app.locals.db.run(
            `INSERT INTO login_audit (username, user_id, success, ip, user_agent, reason) VALUES (?, ?, 1, ?, ?, ?)`,
            [username, user.id, req.ip, req.get('user-agent')?.substring(0, 200) || null, 'success']
        ).catch(() => {});

        // Record login session
        try {
            const sessionId = req.sessionID;
            const ip = req.ip || req.connection?.remoteAddress || 'unknown';
            const ua = req.headers['user-agent'] || '';
            const deviceInfo = parseUserAgent(ua);
            const db = require('../config/database').getDatabase();
            if (db) {
                // Deactivate any existing session for same session ID
                db.prepare('UPDATE login_sessions SET is_active=0 WHERE session_id=?').run(sessionId);
                // Insert new session record
                db.prepare(`
                    INSERT INTO login_sessions (id, user_id, session_id, ip_address, user_agent, device_info)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(require('crypto').randomUUID(), user.id, sessionId, ip, ua.slice(0, 500), deviceInfo);
            }
        } catch (e) { /* non-fatal */ }

        // Force password change if flagged
        if (user.must_change_password) {
            return res.redirect('/auth/change-password');
        }

        // Redirect to dashboard
        res.redirect('/dashboard');
    } catch (error) {
        logger.error('Login error:', error);
        req.flash('error', 'An error occurred during login');
        res.redirect('/auth/login');
    }
});

// Change password page (shown after first login with default credentials)
router.get('/change-password', (req, res) => {
    if (!req.session.user) return res.redirect('/auth/login');
    res.render('pages/change-password', {
        title: 'Change Password',
        layout: false,
        error_msg: req.flash('error'),
        success_msg: req.flash('success')
    });
});

router.post('/change-password', [
    body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('confirmPassword').custom((val, { req: r }) => {
        if (val !== r.body.newPassword) throw new Error('Passwords do not match');
        return true;
    })
], async (req, res) => {
    try {
        if (!req.session.user) return res.redirect('/auth/login');

        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            req.flash('error', errors.array()[0].msg);
            return res.redirect('/auth/change-password');
        }

        const { newPassword } = req.body;
        const db = req.app.locals.db;
        const hashed = await bcrypt.hash(newPassword, 10);

        await db.run(
            'UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?',
            [hashed, req.session.user.id]
        );

        req.session.user.mustChangePassword = false;
        logger.info(`User ${req.session.user.username} changed their password`);
        res.redirect('/dashboard');
    } catch (error) {
        logger.error('Change password error:', error);
        req.flash('error', 'Failed to change password');
        res.redirect('/auth/change-password');
    }
});

// ==================== PASSWORD RESET ====================

// Forgot password page
router.get('/forgot-password', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('pages/forgot-password', {
        title: 'Forgot Password',
        layout: false,
        error_msg: req.flash('error'),
        success_msg: req.flash('success')
    });
});

// Request password reset — generates token and sends email
router.post('/forgot-password', [
    body('email').isEmail().withMessage('Valid email required').normalizeEmail()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            req.flash('error', errors.array()[0].msg);
            return res.redirect('/auth/forgot-password');
        }

        const db = req.app.locals.db;
        const user = await db.get('SELECT id, username, email FROM users WHERE email = ?', [req.body.email]);

        // Always show success to prevent user enumeration
        req.flash('success', 'If that email is registered, a reset link has been sent.');

        if (user) {
            const token = require('crypto').randomBytes(32).toString('hex');
            const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes
            const tokenHash = require('crypto').createHash('sha256').update(token).digest('hex');

            await db.run(
                'UPDATE users SET password_reset_token = ?, password_reset_expires = ? WHERE id = ?',
                [tokenHash, expires, user.id]
            );

            logger.info(`Password reset requested for user: ${user.username}`);

            // Send email (non-blocking — ignore if email not configured)
            try {
                const notificationService = require('../services/notificationService');
                const resetUrl = `${req.protocol}://${req.get('host')}/auth/reset-password/${token}`;
                await notificationService.notify(
                    'Password Reset Request',
                    `Click the link below to reset your password (expires in 10 minutes):\n\n${resetUrl}\n\nIf you did not request this, ignore this email.`
                );
            } catch (e) {
                logger.debug('Password reset email not sent (email may not be configured):', e.message);
            }
        }

        res.redirect('/auth/forgot-password');
    } catch (error) {
        logger.error('Forgot password error:', error);
        req.flash('error', 'An error occurred');
        res.redirect('/auth/forgot-password');
    }
});

// Reset password form
router.get('/reset-password/:token', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const tokenHash = require('crypto').createHash('sha256').update(req.params.token).digest('hex');
        const user = await db.get(
            "SELECT id FROM users WHERE password_reset_token = ? AND password_reset_expires > datetime('now')",
            [tokenHash]
        );

        if (!user) {
            req.flash('error', 'Reset link is invalid or has expired');
            return res.redirect('/auth/forgot-password');
        }

        res.render('pages/reset-password', {
            title: 'Reset Password',
            layout: false,
            token: req.params.token,
            error_msg: req.flash('error')
        });
    } catch (error) {
        logger.error('Reset password page error:', error);
        res.redirect('/auth/forgot-password');
    }
});

// Process password reset
router.post('/reset-password/:token', [
    body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('confirmPassword').custom((val, { req: r }) => {
        if (val !== r.body.newPassword) throw new Error('Passwords do not match');
        return true;
    })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            req.flash('error', errors.array()[0].msg);
            return res.redirect(`/auth/reset-password/${req.params.token}`);
        }

        const db = req.app.locals.db;
        const tokenHash = require('crypto').createHash('sha256').update(req.params.token).digest('hex');
        const user = await db.get(
            "SELECT id, username FROM users WHERE password_reset_token = ? AND password_reset_expires > datetime('now')",
            [tokenHash]
        );

        if (!user) {
            req.flash('error', 'Reset link is invalid or has expired');
            return res.redirect('/auth/forgot-password');
        }

        const hashed = await bcrypt.hash(req.body.newPassword, 10);
        await db.run(
            'UPDATE users SET password = ?, password_reset_token = NULL, password_reset_expires = NULL, must_change_password = 0 WHERE id = ?',
            [hashed, user.id]
        );

        logger.info(`Password reset completed for user: ${user.username}`);
        req.flash('success', 'Password updated successfully. Please log in.');
        res.redirect('/auth/login');
    } catch (error) {
        logger.error('Reset password error:', error);
        req.flash('error', 'An error occurred');
        res.redirect(`/auth/reset-password/${req.params.token}`);
    }
});

// Logout handler
router.get('/logout', (req, res) => {
    const username = req.session.user?.username;
    try {
        const db = require('../config/database').getDatabase();
        if (db) {
            db.prepare('UPDATE login_sessions SET is_active=0 WHERE session_id=?').run(req.sessionID);
        }
    } catch (e) {}
    req.session.destroy((err) => {
        if (err) {
            logger.error('Logout error:', err);
        }
        logger.info(`User logged out: ${username}`);
        res.redirect('/auth/login');
    });
});

// ==================== 2FA / TOTP ====================

// Step-up TOTP challenge page (shown after password is verified)
router.get('/2fa', (req, res) => {
    if (!req.session.pendingUserId) return res.redirect('/auth/login');
    res.render('pages/2fa', {
        title: 'Two-Factor Authentication',
        layout: false,
        error_msg: req.flash('error')
    });
});

router.post('/2fa', [
    body('token').trim().isLength({ min: 6, max: 6 }).isNumeric().withMessage('Enter the 6-digit code')
], async (req, res) => {
    try {
        if (!req.session.pendingUserId) return res.redirect('/auth/login');
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            req.flash('error', errors.array()[0].msg);
            return res.redirect('/auth/2fa');
        }

        const db = req.app.locals.db;
        const user = await db.get('SELECT * FROM users WHERE id = ?', [req.session.pendingUserId]);
        if (!user) {
            delete req.session.pendingUserId;
            return res.redirect('/auth/login');
        }

        const valid = speakeasy.totp.verify({
            secret: user.totp_secret,
            encoding: 'base32',
            token: req.body.token,
            window: 1
        });

        if (!valid) {
            logger.warn(`Failed 2FA attempt for user ${user.username}`);
            req.flash('error', 'Invalid code. Try again.');
            return res.redirect('/auth/2fa');
        }

        delete req.session.pendingUserId;
        let userTheme2fa = 'light';
        try { const p = JSON.parse(user.preferences || '{}'); if (p.theme === 'dark') userTheme2fa = 'dark'; } catch (_) {}
        req.session.user = {
            id: user.id,
            username: user.username,
            name: user.name || user.username,
            email: user.email,
            role: user.role,
            mustChangePassword: !!user.must_change_password,
            theme: userTheme2fa
        };
        await db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
        logger.info(`User logged in (2FA): ${user.username}`);
        if (user.must_change_password) return res.redirect('/auth/change-password');
        res.redirect('/');
    } catch (error) {
        logger.error('2FA verify error:', error);
        req.flash('error', 'An error occurred. Please try again.');
        res.redirect('/auth/2fa');
    }
});

// API: generate TOTP secret + QR code for setup
router.post('/api/2fa/setup', async (req, res) => {
    try {
        if (!req.session.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
        const db = req.app.locals.db;

        const secret = speakeasy.generateSecret({
            name: `ESP32 Dashboard (${req.session.user.username})`,
            length: 20
        });

        // Store pending secret (not yet confirmed)
        await db.run('UPDATE users SET totp_pending = ? WHERE id = ?', [secret.base32, req.session.user.id]);

        const qrUrl = await QRCode.toDataURL(secret.otpauth_url);
        res.json({ success: true, secret: secret.base32, qr: qrUrl });
    } catch (error) {
        logger.error('2FA setup error:', error);
        res.status(500).json({ success: false, message: 'Failed to generate 2FA secret' });
    }
});

// API: confirm TOTP setup with a valid code
router.post('/api/2fa/confirm', [
    body('token').trim().isLength({ min: 6, max: 6 }).isNumeric()
], async (req, res) => {
    try {
        if (!req.session.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Invalid token format' });

        const db = req.app.locals.db;
        const user = await db.get('SELECT totp_pending FROM users WHERE id = ?', [req.session.user.id]);
        if (!user?.totp_pending) return res.status(400).json({ success: false, message: 'No pending 2FA setup' });

        const valid = speakeasy.totp.verify({
            secret: user.totp_pending,
            encoding: 'base32',
            token: req.body.token,
            window: 1
        });

        if (!valid) return res.status(400).json({ success: false, message: 'Invalid code — try again' });

        await db.run(
            'UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = 1 WHERE id = ?',
            [req.session.user.id]
        );
        logger.info(`2FA enabled for user ${req.session.user.username}`);
        res.json({ success: true, message: '2FA enabled successfully' });
    } catch (error) {
        logger.error('2FA confirm error:', error);
        res.status(500).json({ success: false, message: 'Failed to confirm 2FA' });
    }
});

// API: disable 2FA (requires current password confirmation)
router.post('/api/2fa/disable', [
    body('password').notEmpty()
], async (req, res) => {
    try {
        if (!req.session.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Password required' });

        const db = req.app.locals.db;
        const user = await db.get('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
        const valid = await bcrypt.compare(req.body.password, user.password);
        if (!valid) return res.status(403).json({ success: false, message: 'Incorrect password' });

        await db.run(
            'UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0 WHERE id = ?',
            [req.session.user.id]
        );
        logger.info(`2FA disabled for user ${req.session.user.username}`);
        res.json({ success: true, message: '2FA disabled' });
    } catch (error) {
        logger.error('2FA disable error:', error);
        res.status(500).json({ success: false, message: 'Failed to disable 2FA' });
    }
});

// API: get 2FA status for current user
router.get('/api/2fa/status', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
    try {
        const db = req.app.locals.db;
        const user = await db.get('SELECT totp_enabled FROM users WHERE id = ?', [req.session.user.id]);
        res.json({ success: true, enabled: !!user?.totp_enabled });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to get 2FA status' });
    }
});

// Check session status (API)
router.get('/session', (req, res) => {
    if (req.session.user) {
        res.json({
            authenticated: true,
            user: {
                username: req.session.user.username,
                name: req.session.user.name,
                role: req.session.user.role
            }
        });
    } else {
        res.json({ authenticated: false });
    }
});

// ── Forced 2FA setup ──────────────────────────────────────────────────────────

// GET /auth/setup-2fa-required — shown when role mandates 2FA but user hasn't set it up
router.get('/setup-2fa-required', (req, res) => {
    if (!req.session.user?.must_setup_2fa) return res.redirect('/');
    res.render('pages/setup-2fa-required', {
        title: 'Set Up Two-Factor Authentication',
        layout: false
    });
});

// POST /auth/api/2fa/complete-required — called after user confirms TOTP during forced setup
// Clears must_setup_2fa flag so normal navigation resumes
router.post('/api/2fa/complete-required', async (req, res) => {
    if (!req.session.user?.must_setup_2fa) {
        return res.status(400).json({ success: false, message: 'Not in forced 2FA setup' });
    }
    try {
        const db = req.app.locals.db;
        const user = await db.get('SELECT totp_enabled FROM users WHERE id = ?', [req.session.user.id]);
        if (!user?.totp_enabled) {
            return res.status(400).json({ success: false, message: '2FA not yet confirmed' });
        }
        req.session.user.must_setup_2fa = false;
        res.json({ success: true });
    } catch (error) {
        logger.error('complete-required 2FA error:', error);
        res.status(500).json({ success: false, message: 'Failed to complete 2FA setup' });
    }
});

// ── Magic link login ──────────────────────────────────────────────────────────

// GET /auth/magic/:token — one-time passwordless login
router.get('/magic/:token', async (req, res) => {
    try {
        const tokenHash = require('crypto').createHash('sha256').update(req.params.token).digest('hex');
        const db = req.app.locals.db;
        const user = await db.get(
            `SELECT * FROM users WHERE magic_login_token = ? AND magic_login_expires > datetime('now') AND is_active = 1`,
            [tokenHash]
        );

        if (!user) {
            req.flash('error', 'Login link is invalid, expired, or already used.');
            return res.redirect('/auth/login');
        }

        // Expire the token immediately (single use)
        await db.run(
            'UPDATE users SET magic_login_token = NULL, magic_login_expires = NULL, last_login = CURRENT_TIMESTAMP WHERE id = ?',
            [user.id]
        );

        // Regenerate session (session fixation protection)
        await new Promise((resolve, reject) =>
            req.session.regenerate(err => err ? reject(err) : resolve())
        );

        req.session.user = {
            id: user.id,
            username: user.username,
            name: user.name || user.username,
            email: user.email,
            role: user.role,
            mustChangePassword: !!user.must_change_password
        };

        logger.info(`User logged in via magic link: ${user.username}`);
        await db.run(
            `INSERT INTO login_audit (username, user_id, success, ip, user_agent, reason) VALUES (?, ?, 1, ?, ?, ?)`,
            [user.username, user.id, req.ip, req.get('user-agent')?.substring(0, 200) || null, 'magic_link']
        ).catch(() => {});

        if (user.must_change_password) return res.redirect('/auth/change-password');
        res.redirect('/');
    } catch (error) {
        logger.error('Magic link login error:', error);
        req.flash('error', 'An error occurred. Please log in normally.');
        res.redirect('/auth/login');
    }
});

// ── Invite-based registration ─────────────────────────────────────────────────

// GET /auth/register?token=... — show registration form
router.get('/register', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.redirect('/auth/login');

    try {
        const db = req.app.locals.db;
        const invite = await db.get(
            `SELECT * FROM invite_tokens WHERE token = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
            [token]
        );
        if (!invite) {
            req.flash('error', 'Invite link is invalid or has expired.');
            return res.redirect('/auth/login');
        }
        res.render('pages/register', {
            title: 'Create Account',
            layout: false,
            token,
            email: invite.email || '',
            role: invite.role,
            error_msg: req.flash('error')
        });
    } catch (error) {
        logger.error('GET /auth/register error:', error);
        res.redirect('/auth/login');
    }
});

// POST /auth/register — create account from invite
router.post('/register', [
    body('token').notEmpty(),
    body('username').trim().notEmpty().isLength({ min: 3, max: 50 })
        .matches(/^[a-zA-Z0-9_.-]+$/).withMessage('Username: 3-50 chars, letters/numbers/_/./- only'),
    body('name').trim().notEmpty().isLength({ max: 100 }),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('password_confirm').custom((v, { req }) => v === req.body.password).withMessage('Passwords do not match')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        const { token, username, name, password } = req.body;

        if (!errors.isEmpty()) {
            return res.render('pages/register', {
                title: 'Create Account', layout: false, token,
                email: req.body.email || '', role: '',
                error_msg: [errors.array()[0].msg]
            });
        }

        const db = req.app.locals.db;
        const invite = await db.get(
            `SELECT * FROM invite_tokens WHERE token = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
            [token]
        );
        if (!invite) {
            req.flash('error', 'Invite link is invalid or has expired.');
            return res.redirect('/auth/login');
        }

        // Check username uniqueness
        const existing = await db.get(`SELECT id FROM users WHERE username = ?`, [username]);
        if (existing) {
            return res.render('pages/register', {
                title: 'Create Account', layout: false, token,
                email: invite.email || '', role: invite.role,
                error_msg: ['Username already taken']
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await db.run(
            `INSERT INTO users (username, password, name, email, role, is_active, must_change_password)
             VALUES (?, ?, ?, ?, ?, 1, 0)`,
            [username, hashedPassword, name, invite.email || '', invite.role || 'viewer']
        );

        // Mark invite as used
        await db.run(
            `UPDATE invite_tokens SET used_at = CURRENT_TIMESTAMP, used_by = ? WHERE id = ?`,
            [result.lastID, invite.id]
        );

        logger.info(`New user registered via invite: ${username} (role: ${invite.role})`);
        req.flash('success', 'Account created — please log in.');
        res.redirect('/auth/login');
    } catch (error) {
        logger.error('POST /auth/register error:', error);
        req.flash('error', 'Registration failed. Please try again.');
        res.redirect(`/auth/register?token=${req.body.token}`);
    }
});

module.exports = router;
