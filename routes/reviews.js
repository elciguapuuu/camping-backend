const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticateToken } = require('../middleware/jwt');

// Add a new review - Protected (must be logged in)
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { location_id, booking_id, overall_rating, review_comment } = req.body;
        // Use user_id from JWT token instead of request body
        const user_id = req.user.id;

        if (!location_id || !booking_id || !overall_rating) {
            return res.status(400).json({ error: "Missing required fields." });
        }

        // Validate overall_rating , has to be between 1 - 5
        if (overall_rating < 1 || overall_rating > 5) {
            return res.status(400).json({ error: "Overall rating must be between 1 and 5." });
        }

        // Verify the booking belongs to this user
        const [bookings] = await db.query(
            'SELECT * FROM Bookings WHERE booking_id = ? AND user_id = ?',
            [booking_id, user_id]
        );
        
        if (bookings.length === 0) {
            return res.status(403).json({ error: "You can only review your own bookings." });
        }

        // Insert the review into the database
        const [result] = await db.query(
            'INSERT INTO Reviews (user_id, location_id, booking_id, overall_rating, review_comment) VALUES (?, ?, ?, ?, ?)',
            [user_id, location_id, booking_id, overall_rating, review_comment || null] // Allow review_comment to be NULL if not provided
        );

        res.status(201).json({ message: "Review added successfully!", review_id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all reviews for a location - Public
router.get('/:location_id', async (req, res) => {
    try {
        const { location_id } = req.params;
        
        //check if location exists
        const [location] = await db.query('SELECT location_id FROM Locations WHERE location_id = ?', [location_id]);
        
        if (location.length === 0) {
            return res.status(404).json({ error: "Location not found" });
        }

        const [reviews] = await db.query(`
            SELECT r.*, u.name as reviewer_name 
            FROM Reviews r
            JOIN Users u ON r.user_id = u.user_id
            WHERE r.location_id = ?
            ORDER BY r.created_at DESC`, 
            [location_id]
        );

        if (reviews.length === 0) {
            return res.json({ 
                message: "No reviews for this campsite, yet",
                reviews: []
            });
        }

        res.json({ 
            message: `Found ${reviews.length} review(s)`,
            reviews 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
