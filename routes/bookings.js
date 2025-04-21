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
        console.log('Booking request received:', req.body);
        
        const { location_id, start_date, end_date, total_price } = req.body;
        
        // Use user_id from JWT token
        const user_id = req.user.id;

        // Input validation with more detailed errors
        if (!location_id) {
            return res.status(400).json({ error: "Missing location ID" });
        }
        
        if (!start_date) {
            return res.status(400).json({ error: "Missing start date" });
        }
        
        if (!end_date) {
            return res.status(400).json({ error: "Missing end date" });
        }

        // Parse numeric values and validate
        const parsedLocationId = parseInt(location_id);
        if (isNaN(parsedLocationId)) {
            return res.status(400).json({ error: "Invalid location ID format" });
        }

        // Date validation - ensure we have valid dates
        let startDate, endDate;
        try {
            startDate = new Date(start_date);
            endDate = new Date(end_date);
            
            if (isNaN(startDate.getTime())) {
                return res.status(400).json({ error: "Invalid start date format" });
            }
            
            if (isNaN(endDate.getTime())) {
                return res.status(400).json({ error: "Invalid end date format" });
            }
        } catch (dateError) {
            console.error('Date parsing error:', dateError);
            return res.status(400).json({ error: "Invalid date format" });
        }
        
        const today = new Date();
        if (startDate < today) {
            return res.status(400).json({ error: "Start date cannot be in the past" });
        }

        if (startDate >= endDate) {
            return res.status(400).json({ error: "End date must be after start date" });
        }

        // Check if location exists and get price and owner
        const [locationData] = await db.query('SELECT price_per_night, user_id as owner_id, name FROM Locations WHERE location_id = ?', [parsedLocationId]);
        if (locationData.length === 0) {
            return res.status(404).json({ error: "Location not found" });
        }

        // Calculate total price if not provided
        const nights = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
        const calculatedTotalPrice = nights * locationData[0].price_per_night;
        const finalTotalPrice = total_price || calculatedTotalPrice;

        // Format dates for MySQL (YYYY-MM-DD)
        const formatDate = (date) => {
            return date.toISOString().split('T')[0];
        };
        
        const formattedStartDate = formatDate(startDate);
        const formattedEndDate = formatDate(endDate);

        // Check for booking conflicts
        const [conflicts] = await db.query(`
            SELECT COUNT(*) as count 
            FROM Bookings 
            WHERE location_id = ? 
            AND status_id != (SELECT status_id FROM Status WHERE status_name = 'cancelled')
            AND ((start_date BETWEEN ? AND ?) 
            OR (end_date BETWEEN ? AND ?))
        `, [parsedLocationId, formattedStartDate, formattedEndDate, formattedStartDate, formattedEndDate]);

        if (conflicts[0].count > 0) {
            return res.status(409).json({ error: "Location is already booked for these dates" });
        }

        // Get pending status ID
        const [statusData] = await db.query('SELECT status_id FROM Status WHERE status_name = ?', ['pending']);
        if (statusData.length === 0) {
            return res.status(500).json({ error: "Status 'pending' not found in database" });
        }
        
        const status_id = statusData[0].status_id;

        // Create booking - build query with safe values
        const fields = [
            'user_id',
            'location_id', 
            'start_date', 
            'end_date', 
            'total_price', 
            'status_id'
        ];
        
        const values = [
            user_id,
            parsedLocationId,
            formattedStartDate,
            formattedEndDate,
            finalTotalPrice,
            status_id
        ];
        
        // Build SQL query
        const query = `
            INSERT INTO Bookings (${fields.join(', ')}) 
            VALUES (${fields.map(() => '?').join(', ')})
        `;
        
        console.log('Executing SQL:', query, 'with values:', values);
        
        // Execute query
        const [bookingResult] = await db.query(query, values);
        const bookingId = bookingResult.insertId;

        console.log(`Booking created with ID: ${bookingId}`);

        // Return successful response
        res.status(201).json({
            message: "Booking created successfully",
            booking_id: bookingId,
            total_price: finalTotalPrice,
            nights
        });

    } catch (err) {
        console.error('Error creating booking:', err);
        res.status(500).json({ 
            error: 'Failed to create booking',
            details: err.message,
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
});

// Update booking status to confirmed
router.patch('/:id/confirm', async (req, res) => {
    try {
        const bookingId = req.params.id;
        
        // Check if booking exists
        const [booking] = await db.query(`
            SELECT b.*, l.name as location_name, l.user_id as location_owner_id, u.name as guest_name
            FROM Bookings b
            JOIN Locations l ON b.location_id = l.location_id
            JOIN Users u ON b.user_id = u.user_id
            WHERE b.booking_id = ?
        `, [bookingId]);
        
        if (booking.length === 0) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        
        // Check if the current user is the location owner
        if (booking[0].location_owner_id != req.user.id) {
            return res.status(403).json({ error: 'Only the location owner can confirm this booking' });
        }
        
        // Get 'confirmed' status id (status_id 6 based on your info)
        const confirmedStatusId = 6;
        
        // Update booking status
        await db.query('UPDATE Bookings SET status_id = ? WHERE booking_id = ?', 
            [confirmedStatusId, bookingId]);
        
        res.json({ 
            message: 'Booking confirmed successfully',
            booking_id: bookingId,
            status_id: confirmedStatusId
        });
    } catch (err) {
        console.error('Error confirming booking:', err);
        res.status(500).json({ error: 'Failed to confirm booking', details: err.message });
    }
});

// Cancel a booking
router.patch('/:id/cancel', async (req, res) => {
    try {
        const bookingId = req.params.id;
        
        // Check if booking exists
        const [booking] = await db.query(`
            SELECT b.*, l.name as location_name, l.user_id as location_owner_id 
            FROM Bookings b
            JOIN Locations l ON b.location_id = l.location_id
            WHERE b.booking_id = ?
        `, [bookingId]);
        
        if (booking.length === 0) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        
        const bookingData = booking[0];
        const isCancelledByBooker = bookingData.user_id == req.user.id;
        
        // Only the user who made the booking or the location owner can cancel it
        if (bookingData.user_id != req.user.id) {
            // Check if current user is the location owner
            const [location] = await db.query('SELECT user_id as owner_id FROM Locations WHERE location_id = ?', [bookingData.location_id]);
            if (location.length === 0 || location[0].owner_id != req.user.id) {
                return res.status(403).json({ error: 'You do not have permission to cancel this booking' });
            }
        }
        
        // Get 'cancelled' status id (status_id 7 based on your info)
        const cancelledStatusId = 7;
        
        // Update booking status
        await db.query('UPDATE Bookings SET status_id = ? WHERE booking_id = ?', 
            [cancelledStatusId, bookingId]);
        
        res.json({ 
            message: 'Booking cancelled successfully',
            booking_id: bookingId,
            status_id: cancelledStatusId
        });
    } catch (err) {
        console.error('Error cancelling booking:', err);
        res.status(500).json({ error: 'Failed to cancel booking', details: err.message });
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

// Get all bookings for a specific location
router.get('/location/:locationId', async (req, res) => {
    try {
        const locationId = req.params.locationId;
        
        // Check if the location exists
        const [location] = await db.query('SELECT * FROM Locations WHERE location_id = ?', [locationId]);
        
        if (location.length === 0) {
            return res.status(404).json({ error: "Location not found" });
        }
        
        // Check if the current user owns this location
        if (location[0].user_id != req.user.id) {
            return res.status(403).json({ error: "You can only view bookings for your own locations" });
        }
        
        // Get all bookings for this location
        const [bookings] = await db.query(`
            SELECT b.*, 
                   u.name as user_name, 
                   s.status_name,
                   l.name as location_name
            FROM Bookings b
            JOIN Users u ON b.user_id = u.user_id
            JOIN Status s ON b.status_id = s.status_id
            JOIN Locations l ON b.location_id = l.location_id
            WHERE b.location_id = ?
            ORDER BY b.created_at DESC
        `, [locationId]);
        
        res.json(bookings);
    } catch (err) {
        console.error('Error fetching location bookings:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

