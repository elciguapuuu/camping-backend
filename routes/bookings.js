const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticateToken } = require('../middleware/jwt');

// Apply authentication to all booking routes
router.use(authenticateToken);

// Get all bookings (admin only - would need additional admin role check)
router.get('/', async (req, res) => {
    try {
        const [bookings] = await db.query(`
            SELECT 
                b.*,
                l.name as location_name,
                s.status_name,
                u.name as user_name
            FROM Bookings b
            JOIN Locations l ON b.location_id = l.location_id
            JOIN Status s ON b.status_id = s.status_id
            JOIN Users u ON b.user_id = u.user_id
        `);
        res.json(bookings);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch bookings', details: err.message });
    }
});

// Get booking by ID
router.get('/:id', async (req, res) => {
    try {
        const [booking] = await db.query(`
            SELECT 
                b.*,
                l.name as location_name,
                s.status_name,
                u.name as user_name
            FROM Bookings b
            JOIN Locations l ON b.location_id = l.location_id
            JOIN Status s ON b.status_id = s.status_id
            JOIN Users u ON b.user_id = u.user_id
            WHERE b.booking_id = ?
        `, [req.params.id]);

        if (booking.length === 0) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        
        // Check if user owns this booking
        if (booking[0].user_id != req.user.id) {
            return res.status(403).json({ error: 'Access denied: You can only view your own bookings' });
        }

        res.json(booking[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch booking', details: err.message });
    }
});

// Create new booking
router.post('/', async (req, res) => {
    try {
        const { location_id, start_date, end_date } = req.body;
        // Use user_id from JWT token
        const user_id = req.user.id;

        // Input validation
        if (!location_id || !start_date || !end_date) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        // Date validation
        const startDate = new Date(start_date);
        const endDate = new Date(end_date);
        const today = new Date();

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            return res.status(400).json({ error: "Invalid date format" });
        }

        if (startDate < today) {
            return res.status(400).json({ error: "Start date cannot be in the past" });
        }

        if (startDate >= endDate) {
            return res.status(400).json({ error: "End date must be after start date" });
        }

        // Check if location exists and get price
        const [locationData] = await db.query('SELECT price_per_night FROM Locations WHERE location_id = ?', [location_id]);
        if (locationData.length === 0) {
            return res.status(404).json({ error: "Location not found" });
        }

        // Calculate total price
        const nights = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
        const total_price = nights * locationData[0].price_per_night;

        // Check for booking conflicts
        const [conflicts] = await db.query(`
            SELECT COUNT(*) as count 
            FROM Bookings 
            WHERE location_id = ? 
            AND status_id != (SELECT status_id FROM Status WHERE status_name = 'cancelled')
            AND ((start_date BETWEEN ? AND ?) 
            OR (end_date BETWEEN ? AND ?))
        `, [location_id, start_date, end_date, start_date, end_date]);

        if (conflicts[0].count > 0) {
            return res.status(409).json({ error: "Location is already booked for these dates" });
        }

        // Get pending status ID
        const [statusData] = await db.query('SELECT status_id FROM Status WHERE status_name = ?', ['pending']);
        const status_id = statusData[0].status_id;

        // Create booking
        const [bookingResult] = await db.query(
            'INSERT INTO Bookings (user_id, location_id, start_date, end_date, total_price, status_id) VALUES (?, ?, ?, ?, ?, ?)',
            [user_id, location_id, start_date, end_date, total_price, status_id]
        );

        res.status(201).json({
            message: "Booking created successfully",
            booking_id: bookingResult.insertId,
            total_price,
            nights
        });

    } catch (err) {
        res.status(500).json({ error: 'Failed to create booking', details: err.message });
    }
});

// Booking overview for a user
router.get('/user/:userId', async (req, res) => {
    try {
        // Check if user is requesting their own bookings
        if (req.user.id != req.params.userId) {
            return res.status(403).json({ error: "Access denied: You can only view your own bookings" });
        }
        
        const [bookings] = await db.query(`
            SELECT b.*, l.name as location_name, l.city, l.country
            FROM Bookings b
            JOIN Locations l ON b.location_id = l.location_id
            WHERE b.user_id = ?
            ORDER BY b.start_date DESC
        `, [req.params.userId]);
        
        res.json(bookings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

