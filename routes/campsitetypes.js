const express = require('express');
const router = express.Router();
const db = require('../config/db');

// Get all campsite types
router.get('/', async (req, res) => {
    try {
        const [types] = await db.query('SELECT * FROM CampsiteTypes');
        res.json(types);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
