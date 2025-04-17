const express = require('express');
const router = express.Router();
const db = require('../config/db');

// Get all amenities
router.get('/', async (req, res) => {
    try {
        const [amenities] = await db.query('SELECT * FROM Amenities');
        res.json(amenities);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
