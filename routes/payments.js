const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db = require('../config/db'); 
const { authenticateToken } = require('../middleware/jwt'); // Assuming you want to protect this route

// POST /api/payments/create-payment-intent
// Creates a Stripe Payment Intent
router.post('/create-payment-intent', authenticateToken, async (req, res) => {
  const { amount, currency, location_id } = req.body; // Accept amount, currency, and optional location_id directly
  const user_id = req.user.id; // Get user_id from authenticated token

  if (!amount || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: 'Valid amount is required' });
  }
  if (!currency) {
    return res.status(400).json({ error: 'Currency is required' });
  }

  const amountInCents = Math.round(parseFloat(amount) * 100); // Stripe expects amount in cents

  try {
    // Create a PaymentIntent with the order amount and currency
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: currency.toLowerCase(), // Ensure currency is lowercase e.g. 'eur'
      metadata: { 
        // booking_id will be associated later, after booking creation
        user_id: user_id.toString(),
        location_id: location_id ? location_id.toString() : undefined
      },
      automatic_payment_methods: {
        enabled: true,
      },
    });

    // Send the client secret to the client
    res.send({
      clientSecret: paymentIntent.client_secret,
      amount: parseFloat(amount) // Send back amount for display if needed
    });

  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /webhook/stripe - Handles Stripe webhook events
router.post('/webhook/stripe', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; // Ensure this is set in your .env file

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  let connection; // Declare connection outside try blocks for access in finally

  // Handle the event
  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntentSucceeded = event.data.object;
      const { id: stripe_payment_intent_id_succeeded, amount: amountInCents_succeeded, currency: currency_succeeded } = paymentIntentSucceeded;
      const paymentAmount_succeeded = amountInCents_succeeded / 100;

      console.log(`Webhook: Received payment_intent.succeeded for PI: ${stripe_payment_intent_id_succeeded}, Amount: ${paymentAmount_succeeded} ${currency_succeeded}`);

      try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        let associated_booking_id_succeeded = null;
        const [bookings_succeeded] = await connection.query('SELECT booking_id FROM Bookings WHERE stripe_payment_intent_id = ?', [stripe_payment_intent_id_succeeded]);
        if (bookings_succeeded.length > 0) {
          associated_booking_id_succeeded = bookings_succeeded[0].booking_id;
          console.log(`Webhook: Found associated booking ${associated_booking_id_succeeded} for succeeded PI ${stripe_payment_intent_id_succeeded}.`);
        } else {
          console.log(`Webhook: No booking found yet for succeeded PI ${stripe_payment_intent_id_succeeded}. Payment record might have NULL booking_id initially.`);
        }

        const upsertSucceededQuery = `
          INSERT INTO Payments (booking_id, stripe_payment_intent_id, amount, currency, status, created_at, updated_at) 
          VALUES (?, ?, ?, ?, 'succeeded', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON DUPLICATE KEY UPDATE 
            status = 'succeeded', 
            amount = VALUES(amount), 
            currency = VALUES(currency),
            booking_id = IFNULL(Payments.booking_id, VALUES(booking_id)),
            updated_at = CURRENT_TIMESTAMP
        `;
        const [result_succeeded] = await connection.query(upsertSucceededQuery, [associated_booking_id_succeeded, stripe_payment_intent_id_succeeded, paymentAmount_succeeded, currency_succeeded.toLowerCase()]);

        if (result_succeeded.affectedRows > 0 || result_succeeded.insertId > 0) {
          console.log(`Webhook: Payment record for succeeded PI ${stripe_payment_intent_id_succeeded} processed. InsertId: ${result_succeeded.insertId}, AffectedRows: ${result_succeeded.affectedRows}`);
        } else {
          console.log(`Webhook: Payment record for succeeded PI ${stripe_payment_intent_id_succeeded} likely already up-to-date.`);
        }
        
        await connection.commit();
        console.log(`Webhook: Successfully processed payment_intent.succeeded for ${stripe_payment_intent_id_succeeded}`);
      } catch (dbError) {
        if (connection) await connection.rollback();
        console.error(`Webhook: DB error for payment_intent.succeeded ${stripe_payment_intent_id_succeeded}:`, dbError);
        return res.status(500).json({ error: 'Webhook database processing error for payment_intent.succeeded' });
      } finally {
        if (connection) connection.release();
      }
      break;

    case 'payment_intent.payment_failed':
      const paymentIntentFailed = event.data.object;
      const { id: stripe_payment_intent_id_failed, amount: amountInCents_failed, currency: currency_failed, last_payment_error } = paymentIntentFailed;
      const paymentAmount_failed = amountInCents_failed / 100;

      console.log(`Webhook: Received payment_intent.payment_failed for PI: ${stripe_payment_intent_id_failed}. Amount: ${paymentAmount_failed} ${currency_failed}. Reason: ${last_payment_error?.message}`);
      
      try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        let associated_booking_id_failed = null;
        const [bookings_failed] = await connection.query('SELECT booking_id FROM Bookings WHERE stripe_payment_intent_id = ?', [stripe_payment_intent_id_failed]);
        if (bookings_failed.length > 0) {
          associated_booking_id_failed = bookings_failed[0].booking_id;
          console.log(`Webhook: Found associated booking ${associated_booking_id_failed} for failed PI ${stripe_payment_intent_id_failed}.`);
        }

        const upsertFailedQuery = `
          INSERT INTO Payments (booking_id, stripe_payment_intent_id, amount, currency, status, created_at, updated_at) 
          VALUES (?, ?, ?, ?, 'failed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON DUPLICATE KEY UPDATE 
            status = 'failed', 
            amount = VALUES(amount), 
            currency = VALUES(currency),
            booking_id = IFNULL(Payments.booking_id, VALUES(booking_id)), 
            updated_at = CURRENT_TIMESTAMP
        `;
        const [result_failed] = await connection.query(upsertFailedQuery, [associated_booking_id_failed, stripe_payment_intent_id_failed, paymentAmount_failed, currency_failed.toLowerCase()]);

        if (result_failed.affectedRows > 0 || result_failed.insertId > 0) {
          console.log(`Webhook: Payment record for failed PI ${stripe_payment_intent_id_failed} processed. InsertId: ${result_failed.insertId}, AffectedRows: ${result_failed.affectedRows}`);
        } else {
          console.log(`Webhook: Payment record for failed PI ${stripe_payment_intent_id_failed} likely already up-to-date.`);
        }

        await connection.commit();
        console.log(`Webhook: Successfully processed payment_intent.payment_failed for ${stripe_payment_intent_id_failed}`);
      } catch (dbError) {
        if (connection) await connection.rollback();
        console.error(`Webhook: DB error for payment_intent.failed ${stripe_payment_intent_id_failed}:`, dbError);
        return res.status(500).json({ error: 'Webhook database processing error for payment_intent.failed' });
      } finally {
        if (connection) connection.release();
      }
      break;

    default:
      console.log(`Webhook: Unhandled event type ${event.type}. PI ID (if available): ${event.data.object?.id}`);
  }

  // Return a 200 response to acknowledge receipt of the event if not already handled by an error response
  res.status(200).send();
});

module.exports = router;
