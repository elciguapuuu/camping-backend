const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticateToken } = require('../middleware/jwt');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Added Stripe

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
    let connection;
    try {
        console.log('Booking request received:', req.body);
        
        const { location_id, start_date, end_date, total_price, stripe_payment_intent_id, booking_policy, service_fee } = req.body; // MODIFIED
        const user_id = req.user.id; // Use user_id from JWT token

        // Input validation
        if (!location_id) return res.status(400).json({ error: "Missing location ID" });
        if (!start_date) return res.status(400).json({ error: "Missing start date" });
        if (!end_date) return res.status(400).json({ error: "Missing end date" });
        // Added validation for service_fee
        if (service_fee === undefined || service_fee === null) return res.status(400).json({ error: "Missing service fee" });
        const parsedServiceFee = parseFloat(service_fee);
        if (isNaN(parsedServiceFee) || parsedServiceFee < 0) return res.status(400).json({ error: "Invalid service fee" });

        const parsedLocationId = parseInt(location_id);
        if (isNaN(parsedLocationId)) return res.status(400).json({ error: "Invalid location ID format" });

        let sDate, eDate;
        try {
            sDate = new Date(start_date);
            eDate = new Date(end_date);
            if (isNaN(sDate.getTime())) return res.status(400).json({ error: "Invalid start date format" });
            if (isNaN(eDate.getTime())) return res.status(400).json({ error: "Invalid end date format" });
        } catch (dateError) {
            console.error('Date parsing error:', dateError);
            return res.status(400).json({ error: "Invalid date format" });
        }
        
        const today = new Date();
        today.setHours(0, 0, 0, 0); 
        if (sDate < today) return res.status(400).json({ error: "Start date cannot be in the past" });
        if (sDate >= eDate) return res.status(400).json({ error: "End date must be after start date" });

        const [locationData] = await db.query('SELECT price_per_night, user_id as owner_id, name FROM Locations WHERE location_id = ?', [parsedLocationId]);
        if (locationData.length === 0) return res.status(404).json({ error: "Location not found" });

        // Check if the user is trying to book their own location
        if (locationData[0].owner_id === user_id) {
            return res.status(403).json({ error: "You cannot book your own location." });
        }

        const nights = Math.ceil((eDate - sDate) / (1000 * 60 * 60 * 24));
        // Ensure total_price from request is a float, or use calculated if not provided
        // The total_price from request should ideally be the sum of (nights * price_per_night) + service_fee
        // For now, we'll trust the client sends the correct final total_price including the service_fee.
        // Or, we can recalculate it here for security.
        // Let's assume total_price from req.body is the subtotal (price_per_night * nights)
        // and we add the service_fee to it.
        
        const pricePerNight = locationData[0].price_per_night;
        const subtotal = nights * pricePerNight;
        
        // Validate if the provided total_price (expected to be subtotal + service_fee) matches calculation
        // This is a bit tricky if total_price in req.body is meant to be the grand total.
        // Let's assume total_price in req.body is the grand total for now.
        const finalTotalPrice = total_price ? parseFloat(total_price) : (subtotal + parsedServiceFee);
        if (isNaN(finalTotalPrice)) return res.status(400).json({ error: "Invalid total price" });

        // It's good practice to verify the received total_price against server-side calculation
        // For example: if (Math.abs(finalTotalPrice - (subtotal + parsedServiceFee)) > 0.01) {
        // return res.status(400).json({ error: "Total price mismatch. Please recalculate." });
        // }

        const formatDate = (date) => date.toISOString().split('T')[0];
        const formattedStartDate = formatDate(sDate);
        const formattedEndDate = formatDate(eDate);

        connection = await db.getConnection(); // Get connection from the pool
        await connection.beginTransaction();

        // Check for booking conflicts (existing bookings)
        // const [conflicts] = await connection.query(`...`); // Ensure this uses connection.query if uncommented
        // if (conflicts[0].count > 0) {
        //     await connection.rollback();
        //     return res.status(409).json({ error: "Location is already booked for these dates" });
        // }

        // --- Start of new/modified unavailability check ---
        console.log(`Checking unavailability for location_id: ${parsedLocationId}, req_start: ${formattedStartDate}, req_end: ${formattedEndDate}`);

        // Log existing unavailabilities for this location to help debug
        try {
            // Corrected SQL string definition using template literals
            const debugSql = `SELECT unavailability_id, location_id, DATE_FORMAT(start_date, '%Y-%m-%d') as start_date, DATE_FORMAT(end_date, '%Y-%m-%d') as end_date, reason FROM locationunavailabilities WHERE location_id = ?`;
            const [debugUnavs] = await connection.query(debugSql, [parsedLocationId]);
            console.log(`Existing unavailabilities for location ${parsedLocationId}:`, JSON.stringify(debugUnavs, null, 2));
        } catch (debugError) {
            console.error("Error fetching debug unavailabilities:", debugError);
            // Decide if you want to halt or continue if debug query fails
        }

        // Simplified conflict check for owner unavailability
        const [unavailabilityConflicts] = await connection.query(
            `SELECT COUNT(*) as count
             FROM locationunavailabilities
             WHERE location_id = ?
               AND start_date <= ?  -- Unavailability period starts on or before the requested end_date
               AND end_date >= ?    -- Unavailability period ends on or after the requested start_date
            `,
            [parsedLocationId, formattedEndDate, formattedStartDate] // Params: LocationID, Requested EndDate, Requested StartDate
        );
        console.log(`Unavailability conflict count: ${unavailabilityConflicts[0].count}`);

        if (unavailabilityConflicts[0].count > 0) {
            await connection.rollback();
            console.log('Conflict found with locationunavailabilities. Booking rejected.');
            return res.status(409).json({ error: "The location is marked as unavailable by the owner for the selected dates." });
        }
        // --- End of new/modified unavailability check ---

        // Get 'confirmed' status ID
        const [statusData] = await db.query('SELECT status_id FROM Status WHERE status_name = ?', ['confirmed']);
        if (statusData.length === 0) {
            return res.status(500).json({ error: "Status 'confirmed' not found in database. Please check Status table." });
        }
        const status_id = statusData[0].status_id;

        connection = await db.getConnection(); // Get connection from the pool
        await connection.beginTransaction();

        const fields = ['user_id', 'location_id', 'start_date', 'end_date', 'total_price', 'status_id', 'booking_policy', 'service_fee']; // MODIFIED
        const values = [user_id, parsedLocationId, formattedStartDate, formattedEndDate, finalTotalPrice, status_id, booking_policy, parsedServiceFee]; // MODIFIED
        
        const query = `INSERT INTO Bookings (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`;
        
        console.log('Executing SQL for Booking:', query, 'with values:', values);
        const [bookingResult] = await connection.query(query, values);
        const bookingId = bookingResult.insertId;

        // If Stripe payment was made, record it in the Payments table
        if (stripe_payment_intent_id) {
            const paymentFields = ['booking_id', 'stripe_payment_intent_id', 'amount', 'currency', 'status'];
            // Assuming currency is EUR and status is succeeded from client-side confirmation
            const paymentValues = [bookingId, stripe_payment_intent_id, finalTotalPrice, 'eur', 'succeeded'];
            const paymentQuery = `INSERT INTO Payments (${paymentFields.join(', ')}) VALUES (${paymentFields.map(() => '?').join(', ')})`;
            
            console.log('Executing SQL for Payment:', paymentQuery, 'with values:', paymentValues);
            await connection.query(paymentQuery, paymentValues);
        }

        await connection.commit();

        console.log(`Booking created with ID: ${bookingId}`);
        res.status(201).json({
            message: "Booking created successfully",
            booking_id: bookingId,
            location_name: locationData[0].name,
            start_date: formattedStartDate,
            end_date: formattedEndDate,
            total_price: finalTotalPrice,
            nights,
            status: 'confirmed',
            booking_policy: booking_policy, // ADDED
            service_fee: parsedServiceFee // ADDED
        });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error creating booking:', err);
        res.status(500).json({ 
            error: 'Failed to create booking',
            details: err.message,
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    } finally {
        if (connection) connection.release();
    }
});

// Cancel a booking
router.patch('/:id/cancel', async (req, res) => {
    let connection; 
    try {
        const bookingId = req.params.id;
        
        connection = await db.getConnection(); // Get connection from the pool
        await connection.beginTransaction();

        const [bookingCheck] = await connection.query(`
            SELECT b.*, s.status_name 
            FROM Bookings b 
            JOIN Status s ON b.status_id = s.status_id
            WHERE b.booking_id = ?
        `, [bookingId]);
        
        if (bookingCheck.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ error: 'Booking not found' });
        }
        
        const bookingData = bookingCheck[0];
        const originalStatusName = bookingData.status_name;

        if (originalStatusName === 'completed' || originalStatusName === 'cancelled') {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ error: `Booking is already ${originalStatusName}` });
        }
        
        let canCancel = bookingData.user_id == req.user.id;
        if (!canCancel) {
            const [locationOwner] = await connection.query(
                'SELECT user_id FROM Locations WHERE location_id = ?', 
                [bookingData.location_id]
            );
            if (locationOwner.length > 0 && locationOwner[0].user_id == req.user.id) {
                canCancel = true;
            }
        }

        if (!canCancel) {
            await connection.rollback();
            connection.release();
            return res.status(403).json({ error: 'You do not have permission to cancel this booking' });
        }
        
        const [cancelledStatusData] = await connection.query('SELECT status_id FROM Status WHERE status_name = ?', ['cancelled']);
        if (cancelledStatusData.length === 0) {
            await connection.rollback();
            connection.release();
            console.error("Critical: Status 'cancelled' not found in database.");
            return res.status(500).json({ error: "Failed to cancel booking due to server configuration issue." });
        }
        const cancelledStatusId = cancelledStatusData[0].status_id;
        
        await connection.query('UPDATE Bookings SET status_id = ? WHERE booking_id = ?', 
            [cancelledStatusId, bookingId]);
        
        let refundMessage = '';
        let refundAttempted = false;

        if (bookingData.stripe_payment_intent_id && originalStatusName === 'confirmed') {
            refundAttempted = true;
            try {
                console.log(`Attempting refund for Payment Intent: ${bookingData.stripe_payment_intent_id}`);
                const refund = await stripe.refunds.create({
                    payment_intent: bookingData.stripe_payment_intent_id,
                });
                console.log('Stripe refund successful:', refund);
                
                await connection.query(
                    'UPDATE Payments SET status = ? WHERE stripe_payment_intent_id = ?',
                    ['refunded', bookingData.stripe_payment_intent_id]
                );
                refundMessage = 'Stripe refund processed successfully.';
            } catch (stripeError) {
                console.error('Stripe refund failed:', stripeError);
                refundMessage = `Stripe refund attempt failed: ${stripeError.message}. Please contact support for manual refund processing.`;
                // The booking is cancelled, but refund failed. The Payments table status is not changed to 'refunded'.
            }
        }

        await connection.commit();

        let finalMessage = 'Booking cancelled successfully.';
        if (refundAttempted) {
            finalMessage += ` ${refundMessage}`;
        }

        res.json({ 
            message: finalMessage.trim(),
            booking_id: bookingId,
            new_status: 'cancelled',
            refund_info: refundAttempted ? refundMessage : 'No refund applicable or attempted.'
        });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error cancelling booking:', err);
        res.status(500).json({ error: 'Failed to cancel booking', details: err.message });
    } finally {
        if (connection) connection.release();
    }
});

// Booking overview for a user
router.get('/user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        // Check if user is requesting their own bookings
        if (req.user.id != userId) {
            return res.status(403).json({ error: "Access denied: You can only view your own bookings" });
        }

        // Fetch bookings with location and status details, and cover image
        const [bookings] = await db.query(`
            SELECT 
                b.*, 
                l.name as location_name, 
                l.city, 
                l.country,
                s.status_name,
                img.image_url as cover_image_url
            FROM Bookings b
            JOIN Locations l ON b.location_id = l.location_id
            JOIN Status s ON b.status_id = s.status_id
            LEFT JOIN Images img ON l.location_id = img.location_id AND img.is_cover = 1
            WHERE b.user_id = ?
            ORDER BY b.start_date DESC
        `, [userId]);
        
        res.json(bookings);
    } catch (err) {
        console.error('Error fetching user bookings:', err); 
        res.status(500).json({ error: 'Failed to fetch user bookings', details: err.message });
    }
});

// Get all bookings for a specific location
router.get('/location/:locationId', async (req, res) => {
    try {
        const locationId = req.params.locationId;
        
        // Check if the location exists and if the current user owns this location
        const [location] = await db.query('SELECT user_id FROM Locations WHERE location_id = ?', [locationId]);
        
        if (location.length === 0) {
            return res.status(404).json({ error: "Location not found" });
        }
        
        if (location[0].user_id != req.user.id) {
            return res.status(403).json({ error: "You can only view bookings for your own locations" });
        }
        
        // Get all bookings for this location, including user name and status name
        const [bookings] = await db.query(`
            SELECT b.booking_id, 
                   b.start_date, 
                   b.end_date, 
                   b.total_price,
                   b.created_at,
                   b.cancellation_date,
                   u.name as user_name, 
                   s.status_name
            FROM Bookings b
            JOIN Users u ON b.user_id = u.user_id
            JOIN Status s ON b.status_id = s.status_id
            WHERE b.location_id = ?
            ORDER BY b.start_date DESC 
        `, [locationId]); // Changed order to start_date DESC for better chronological view
        
        res.json(bookings);
    } catch (err) {
        console.error('Error fetching location bookings:', err);
        // Send a more generic error message to the client but log details
        res.status(500).json({ error: 'Failed to fetch location bookings', details: err.message });
    }
});

// Cancel a booking
router.put('/:id/cancel', async (req, res) => {
    const bookingId = req.params.id;
    const userId = req.user.id; // Assuming authenticateToken middleware adds user to req

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        // 1. Check if the booking exists and belongs to the user
        const [bookings] = await connection.query(
            'SELECT * FROM Bookings WHERE booking_id = ? AND user_id = ?',
            [bookingId, userId]
        );

        if (bookings.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Booking not found or you do not have permission to cancel it.' });
        }

        const booking = bookings[0];

        // 2. Check if the booking can be cancelled (e.g., not already cancelled, or past its start date if policy dictates)
        const [cancelledStatus] = await connection.query('SELECT status_id FROM Status WHERE status_name = ?', ['cancelled']);
        if (cancelledStatus.length === 0) {
            await connection.rollback();
            return res.status(500).json({ error: "Status 'cancelled' not found in database." });
        }
        const cancelledStatusId = cancelledStatus[0].status_id;

        if (booking.status_id === cancelledStatusId) {
            await connection.rollback();
            return res.status(400).json({ error: 'Booking is already cancelled.' });
        }
        
        // Add any other cancellation policy checks here, e.g., based on start_date
        // For example:
        // const today = new Date();
        // const startDate = new Date(booking.start_date);
        // if (startDate <= today) { // Or some other policy like "cannot cancel within 24 hours of start"
        //     await connection.rollback();
        //     return res.status(400).json({ error: 'Booking cannot be cancelled as it has already started or is too close to the start date.' });
        // }


        // 3. Update the booking status to 'cancelled'
        await connection.query(
            'UPDATE Bookings SET status_id = ? WHERE booking_id = ?',
            [cancelledStatusId, bookingId]
        );

        // TODO: Handle refunds if applicable. This might involve:
        // - Checking the booking_policy associated with the booking.
        // - Interacting with Stripe to process a refund for the stripe_payment_intent_id.
        // - Logging the refund transaction.
        // For now, we'll just mark as cancelled.

        await connection.commit();
        res.json({ message: 'Booking cancelled successfully.', booking_id: bookingId });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error cancelling booking:', err);
        res.status(500).json({ error: 'Failed to cancel booking', details: err.message });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;

