const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const logger = require('../utils/logger');
const { formatPhoneNumber } = require('../utils/phoneNumber');

function isValidNumericId(id) {
    return /^[0-9]+$/.test(String(id));
}

/**
 * @swagger
 * tags:
 *   name: Contacts
 *   description: Address book management
 */

/**
 * @swagger
 * /contacts:
 *   get:
 *     summary: List contacts with optional search and pagination
 *     tags: [Contacts]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 500 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by name or phone number
 *       - in: query
 *         name: favorites
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: Contact list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Contact' }
 *                 pagination: { $ref: '#/components/schemas/Pagination' }
 */
router.get('/', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 500);
        const offset = (page - 1) * limit;
        const search = req.query.search || '';

        let query = 'SELECT * FROM contacts';
        let countQuery = 'SELECT COUNT(*) as count FROM contacts';
        let params = [];
        let whereClauses = [];

        if (search) {
            whereClauses.push('(name LIKE ? OR phone_number LIKE ? OR email LIKE ?)');
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        if (whereClauses.length > 0) {
            const whereString = ' WHERE ' + whereClauses.join(' AND ');
            query += whereString;
            countQuery += whereString;
        }

        query += ' ORDER BY favorite DESC, name ASC LIMIT ? OFFSET ?';
        
        const queryParams = [...params, limit, offset];
        const countParams = [...params];

        const contacts = await db.all(query, queryParams);
        const total = await db.get(countQuery, countParams);

        res.json({
            success: true,
            data: contacts,
            pagination: {
                page,
                limit,
                total: total.count,
                pages: Math.ceil(total.count / limit)
            }
        });
    } catch (error) {
        logger.error('API contacts list error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch contacts',
        });
    }
});

// Search contacts
router.get('/search/:query', async (req, res) => {
    try {
        const { query } = req.params;
        const db = req.app.locals.db;
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 10), 200);

        const contacts = await db.all(`
            SELECT id, name, phone_number, favorite
            FROM contacts
            WHERE name LIKE ? OR phone_number LIKE ? 
            ORDER BY favorite DESC, name ASC 
            LIMIT ?
        `, [`%${query}%`, `%${query}%`, limit]);

        res.json({
            success: true,
            data: contacts
        });
    } catch (error) {
        logger.error('API search contacts error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to search contacts',
        });
    }
});

// Get single contact
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidNumericId(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid contact id'
            });
        }
        const db = req.app.locals.db;

        const contact = await db.get('SELECT * FROM contacts WHERE id = ?', [id]);

        if (!contact) {
            return res.status(404).json({
                success: false,
                message: 'Contact not found'
            });
        }

        res.json({
            success: true,
            data: contact
        });
    } catch (error) {
        logger.error('API get contact error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch contact',
        });
    }
});

// Create new contact
router.post('/', [
    body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 100 }),
    body('phone_number').trim().notEmpty().withMessage('Phone number is required').isLength({ max: 30 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { name, phone_number, email, company, favorite, notes } = req.body;
        const db = req.app.locals.db;

        // Format phone number
        const formattedNumber = formatPhoneNumber(phone_number);

        const result = await db.run(`
            INSERT INTO contacts (name, phone_number, email, company, favorite, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [
            name, 
            formattedNumber, 
            email || null, 
            company || null, 
            favorite ? 1 : 0, 
            notes || null
        ]);

        logger.info(`Contact created: ${name}`);

        const newContact = await db.get('SELECT * FROM contacts WHERE id = ?', [result.lastID]);

        if (global.io) global.io.emit('contact:created', newContact);
        res.json({
            success: true,
            message: 'Contact created successfully',
            data: newContact
        });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || (error.message && error.message.includes('UNIQUE constraint failed'))) {
            return res.status(409).json({
                success: false,
                message: 'A contact with this phone number already exists'
            });
        }
        logger.error('API create contact error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create contact',
        });
    }
});

// Update contact
router.put('/:id', [
    body('name').optional().trim().notEmpty().isLength({ max: 100 }),
    body('phone_number').optional().trim().notEmpty().isLength({ max: 30 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { id } = req.params;
        if (!isValidNumericId(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid contact id'
            });
        }
        const { name, phone_number, email, company, favorite, notes } = req.body;
        const db = req.app.locals.db;

        // Check if contact exists
        const existing = await db.get('SELECT * FROM contacts WHERE id = ?', [id]);
        if (!existing) {
            return res.status(404).json({
                success: false,
                message: 'Contact not found'
            });
        }

        // Build update query
        let updates = [];
        let params = [];
        
        if (name !== undefined) {
            updates.push('name = ?');
            params.push(name);
        }
        if (phone_number !== undefined) {
            updates.push('phone_number = ?');
            params.push(formatPhoneNumber(phone_number));
        }
        if (email !== undefined) {
            updates.push('email = ?');
            params.push(email || null);
        }
        if (company !== undefined) {
            updates.push('company = ?');
            params.push(company || null);
        }
        if (favorite !== undefined) {
            updates.push('favorite = ?');
            params.push(favorite ? 1 : 0);
        }
        if (notes !== undefined) {
            updates.push('notes = ?');
            params.push(notes || null);
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        
        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields to update'
            });
        }

        params.push(id);
        await db.run(`
            UPDATE contacts 
            SET ${updates.join(', ')}
            WHERE id = ?
        `, params);

        logger.info(`Contact updated: ${id}`);

        const updatedContact = await db.get('SELECT * FROM contacts WHERE id = ?', [id]);

        if (global.io) global.io.emit('contact:updated', updatedContact);
        res.json({
            success: true,
            message: 'Contact updated successfully',
            data: updatedContact
        });
    } catch (error) {
        logger.error('API update contact error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update contact',
        });
    }
});

// Delete contact
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidNumericId(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid contact id'
            });
        }
        const db = req.app.locals.db;

        const result = await db.run('DELETE FROM contacts WHERE id = ?', [id]);

        if (result.changes === 0) {
            return res.status(404).json({
                success: false,
                message: 'Contact not found'
            });
        }

        logger.info(`Contact deleted: ${id}`);

        if (global.io) global.io.emit('contact:deleted', { id });
        res.json({
            success: true,
            message: 'Contact deleted successfully'
        });
    } catch (error) {
        logger.error('API delete contact error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete contact',
        });
    }
});

// Toggle favorite
router.patch('/:id/favorite', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidNumericId(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid contact id'
            });
        }
        const { favorite } = req.body;
        const db = req.app.locals.db;

        // Check if contact exists
        const existing = await db.get('SELECT * FROM contacts WHERE id = ?', [id]);
        if (!existing) {
            return res.status(404).json({
                success: false,
                message: 'Contact not found'
            });
        }

        await db.run(
            'UPDATE contacts SET favorite = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [favorite ? 1 : 0, id]
        );

        const updatedContact = await db.get('SELECT * FROM contacts WHERE id = ?', [id]);

        logger.info(`Contact ${id} favorite toggled to ${favorite}`);

        if (global.io) global.io.emit('contact:favorite', { id, is_favorite: updatedContact.favorite });
        res.json({
            success: true,
            message: favorite ? 'Added to favorites' : 'Removed from favorites',
            data: updatedContact
        });
    } catch (error) {
        logger.error('API toggle favorite error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update favorite status'
        });
    }
});

// ==================== IMPORT / EXPORT ====================

/**
 * Export contacts as CSV
 * GET /api/contacts/export/csv
 */
router.get('/export/csv', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const contacts = await db.all(
            'SELECT name, phone_number, email, company, notes, favorite FROM contacts ORDER BY name'
        );

        const escape = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
        const header = 'name,phone_number,email,company,notes,favorite\n';
        const rows = contacts.map(c =>
            [c.name, c.phone_number, c.email, c.company, c.notes, c.favorite ? '1' : '0'].map(escape).join(',')
        ).join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0,10)}.csv"`);
        res.send(header + rows);
    } catch (error) {
        logger.error('Contact CSV export error:', error);
        res.status(500).json({ success: false, message: 'Failed to export contacts' });
    }
});

/**
 * Import contacts from CSV
 * POST /api/contacts/import/csv
 * Body: multipart with 'file' field containing CSV
 * CSV columns: name, phone_number, email (optional), company (optional), notes (optional)
 */
const multer = require('multer');
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1 * 1024 * 1024 } });

router.post('/import/csv', csvUpload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const text = req.file.buffer.toString('utf-8');
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) {
            return res.status(400).json({ success: false, message: 'CSV must have a header row and at least one data row' });
        }

        // Parse header
        const parseRow = (line) => {
            const cells = [];
            let cur = '', inQuote = false;
            for (const ch of line) {
                if (ch === '"') { inQuote = !inQuote; }
                else if (ch === ',' && !inQuote) { cells.push(cur.trim()); cur = ''; }
                else { cur += ch; }
            }
            cells.push(cur.trim());
            return cells;
        };

        const headers = parseRow(lines[0]).map(h => h.toLowerCase().replace(/[^a-z_]/g, '_'));
        const nameIdx  = headers.indexOf('name');
        const phoneIdx = headers.indexOf('phone_number') !== -1 ? headers.indexOf('phone_number') : headers.indexOf('phone');
        if (nameIdx === -1 || phoneIdx === -1) {
            return res.status(400).json({ success: false, message: 'CSV must have "name" and "phone_number" columns' });
        }
        const emailIdx   = headers.indexOf('email');
        const companyIdx = headers.indexOf('company');
        const notesIdx   = headers.indexOf('notes');
        const favIdx     = headers.indexOf('favorite');

        const db = req.app.locals.db;
        let imported = 0, skipped = 0;

        for (let i = 1; i < lines.length; i++) {
            const cells = parseRow(lines[i]);
            const name  = cells[nameIdx]?.replace(/^"|"$/g, '') || '';
            const phone = cells[phoneIdx]?.replace(/^"|"$/g, '') || '';
            if (!name || !phone) { skipped++; continue; }

            const formatted = formatPhoneNumber(phone);
            if (!formatted) { skipped++; continue; }

            try {
                await db.run(
                    `INSERT INTO contacts (name, phone_number, email, company, notes, favorite)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(phone_number) DO UPDATE SET
                         name    = excluded.name,
                         email   = COALESCE(excluded.email, email),
                         company = COALESCE(excluded.company, company),
                         notes   = COALESCE(excluded.notes, notes)`,
                    [
                        name,
                        formatted,
                        emailIdx >= 0 ? (cells[emailIdx]?.replace(/^"|"$/g, '') || null) : null,
                        companyIdx >= 0 ? (cells[companyIdx]?.replace(/^"|"$/g, '') || null) : null,
                        notesIdx >= 0 ? (cells[notesIdx]?.replace(/^"|"$/g, '') || null) : null,
                        favIdx >= 0 ? (cells[favIdx] === '1' ? 1 : 0) : 0
                    ]
                );
                imported++;
            } catch (e) {
                skipped++;
            }
        }

        logger.info(`CSV import: ${imported} contacts imported, ${skipped} skipped`);
        res.json({ success: true, message: `Imported ${imported} contacts (${skipped} skipped)`, imported, skipped });
    } catch (error) {
        logger.error('Contact CSV import error:', error);
        res.status(500).json({ success: false, message: 'Failed to import contacts' });
    }
});

/**
 * Export contacts as vCard (.vcf)
 * GET /api/contacts/export/vcf
 */
router.get('/export/vcf', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const contacts = await db.all(
            'SELECT name, phone_number, email, company, notes FROM contacts ORDER BY name'
        );

        const esc = (v) => String(v || '').replace(/[\\,;]/g, c => '\\' + c).replace(/\n/g, '\\n');

        const vcf = contacts.map(c => [
            'BEGIN:VCARD',
            'VERSION:3.0',
            `FN:${esc(c.name)}`,
            `N:${esc(c.name)};;;;`,
            c.phone_number ? `TEL;TYPE=CELL:${esc(c.phone_number)}` : null,
            c.email        ? `EMAIL:${esc(c.email)}` : null,
            c.company      ? `ORG:${esc(c.company)}` : null,
            c.notes        ? `NOTE:${esc(c.notes)}` : null,
            'END:VCARD'
        ].filter(Boolean).join('\r\n')).join('\r\n\r\n');

        res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0,10)}.vcf"`);
        res.send(vcf);
    } catch (error) {
        logger.error('Contact vCard export error:', error);
        res.status(500).json({ success: false, message: 'Failed to export contacts' });
    }
});

/**
 * Import contacts from vCard (.vcf)
 * POST /api/contacts/import/vcf
 * Body: multipart with 'file' field containing a .vcf file
 */
router.post('/import/vcf', csvUpload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const text = req.file.buffer.toString('utf8');
        // Split into individual vCards
        const cards = text.split(/END:VCARD/i).map(s => s.trim()).filter(Boolean);

        const db = req.app.locals.db;
        let imported = 0, skipped = 0;

        function getField(card, field) {
            // Matches FIELD:value or FIELD;param=...:value
            const re = new RegExp(`^${field}(?:;[^:]*)?:(.+)`, 'im');
            const m = card.match(re);
            return m ? m[1].trim().replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\') : '';
        }

        for (const card of cards) {
            if (!card.match(/BEGIN:VCARD/i)) continue;

            const name  = getField(card, 'FN') || getField(card, 'N').split(';')[0];
            const phone = getField(card, 'TEL');
            if (!name || !phone) { skipped++; continue; }

            const formatted = formatPhoneNumber(phone);
            if (!formatted) { skipped++; continue; }

            const email   = getField(card, 'EMAIL');
            const company = getField(card, 'ORG');
            const notes   = getField(card, 'NOTE');

            try {
                await db.run(
                    `INSERT INTO contacts (name, phone_number, email, company, notes)
                     VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT(phone_number) DO UPDATE SET
                         name = excluded.name,
                         email = COALESCE(excluded.email, email),
                         company = COALESCE(excluded.company, company),
                         notes = COALESCE(excluded.notes, notes)`,
                    [name, formatted, email || null, company || null, notes || null]
                );
                imported++;
            } catch (_) { skipped++; }
        }

        logger.info(`vCard import: ${imported} imported, ${skipped} skipped`);
        res.json({ success: true, imported, skipped });
    } catch (error) {
        logger.error('Contact vCard import error:', error);
        res.status(500).json({ success: false, message: 'Failed to import contacts' });
    }
});

module.exports = router;