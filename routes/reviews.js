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

        // Verify the booking belongs to this user and is completed
        const [bookings] = await db.query(
            'SELECT b.booking_id, s.status_name FROM Bookings b JOIN Status s ON b.status_id = s.status_id WHERE b.booking_id = ? AND b.user_id = ?',
            [booking_id, user_id]
        );
        
        if (bookings.length === 0) {
            return res.status(403).json({ error: "Booking not found or does not belong to you." });
        }

        if (bookings[0].status_name !== 'completed') {
            return res.status(403).json({ error: "You can only review completed bookings." });
        }

        // Check if the user already has a review for this location
        const [existingLocationReviews] = await db.query(
            'SELECT review_id FROM Reviews WHERE user_id = ? AND location_id = ?',
            [user_id, location_id]
        );

        if (existingLocationReviews.length > 0) {
            return res.status(400).json({ error: "You have already reviewed this location." });
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

// Get average rating for a location - Public
router.get('/:location_id/average', async (req, res) => {
    try {
        const { location_id } = req.params;
        // Check if location exists
        const [locations] = await db.query('SELECT location_id FROM Locations WHERE location_id = ?', [location_id]);
        if (locations.length === 0) {
            return res.status(404).json({ error: "Location not found" });
        }

        // Get average rating and count
        const [rows] = await db.query(
            `SELECT AVG(overall_rating) as averageRating, COUNT(*) as reviewCount
             FROM Reviews
             WHERE location_id = ?
             GROUP BY location_id`,
            [location_id]
        );
        if (!rows || rows.length === 0) {
            return res.json({ averageRating: 0, reviewCount: 0 });
        }
        const row = rows[0];
        return res.json({
            averageRating: parseFloat(row.averageRating) || 0,
            reviewCount: parseInt(row.reviewCount) || 0
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Update an existing review - Protected (must be logged in and own the review)
router.put('/:review_id', authenticateToken, async (req, res) => {
    try {
        const { review_id } = req.params;
        const { overall_rating, review_comment } = req.body;
        const user_id = req.user.id;

        if (!overall_rating) {
            return res.status(400).json({ error: "Missing overall rating." });
        }
        if (overall_rating < 1 || overall_rating > 5) {
            return res.status(400).json({ error: "Overall rating must be between 1 and 5." });
        }

        // Verify the review exists and belongs to the user
        const [review] = await db.query('SELECT * FROM Reviews WHERE review_id = ? AND user_id = ?', [review_id, user_id]);

        if (review.length === 0) {
            return res.status(404).json({ error: "Review not found or you do not have permission to edit it." });
        }

        // Update the review
        await db.query(
            'UPDATE Reviews SET overall_rating = ?, review_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE review_id = ?',
            [overall_rating, review_comment || null, review_id]
        );

        res.json({ message: "Review updated successfully!" });
    } catch (err) {
        console.error("Error updating review:", err);
        res.status(500).json({ error: "Failed to update review", details: err.message });
    }
});

module.exports = router;
