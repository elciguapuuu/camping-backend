const db = require('../config/db'); // Assuming your database connection setup is in ../config/db.js

async function getStatusId(statusName) {
    const [rows] = await db.query('SELECT status_id FROM Status WHERE status_name = ?', [statusName]);
    if (rows.length === 0) {
        throw new Error(`Status '${statusName}' not found.`);
    }
    return rows[0].status_id;
}

async function updatePastBookingsToCompleted() {
    console.log('Starting task: Update past bookings to completed...');
    let updatedCount = 0;
    try {
        const completedStatusId = await getStatusId('completed');
        const confirmedStatusId = await getStatusId('confirmed');
        
        const today = new Date().toISOString().slice(0, 10); // Get YYYY-MM-DD

        const [bookingsToUpdate] = await db.query(
            `SELECT booking_id FROM Bookings WHERE end_date < ? AND status_id = ?`,
            [today, confirmedStatusId]
        );

        if (bookingsToUpdate.length === 0) {
            console.log('No bookings found that need to be updated to "completed".');
            return;
        }

        console.log(`Found ${bookingsToUpdate.length} bookings to update.`);

        for (const booking of bookingsToUpdate) {
            await db.query(
                'UPDATE Bookings SET status_id = ? WHERE booking_id = ?',
                [completedStatusId, booking.booking_id]
            );
            updatedCount++;
        }

        console.log(`Successfully updated ${updatedCount} bookings to "completed".`);

    } catch (error) {
        console.error('Error updating past bookings to completed:', error);
    } finally {
        // Close the database connection if the script is standalone and db.js doesn't handle pooling well for scripts
        // For instance, if db.end() is available and appropriate:
        if (db.end) {
            await db.end();
            console.log('Database connection closed.');
        }
    }
}

// Run the task
updatePastBookingsToCompleted();
