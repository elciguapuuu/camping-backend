const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticateToken } = require('../middleware/jwt');
const { enhancedGeocode } = require('../config/geocoder');
const multer = require('multer');
const cloudinary = require('../config/cloudinary'); // Add Cloudinary

// Configure storage for Multer to use memory storage for Cloudinary
const storage = multer.memoryStorage(); // Changed from diskStorage to memoryStorage

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Get all locations - Public
router.get('/', async (req, res) => {
    try {
        const [locations] = await db.query('SELECT * FROM Locations');
        res.json(locations);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

//Add a new location with predefined campsite types - Protected
router.post('/', authenticateToken, async (req, res) => {
    let connection;
    try {
        const { 
            name, 
            description, 
            campsitetypes_id, 
            campsite_types,
            amenities, 
            price_per_night, 
            address,
            city, 
            country,
            latitude: manualLatitude,
            longitude: manualLongitude,
            booking_policy, // Added
            service_fee_percentage // Added
        } = req.body;
        
        // Use user_id from JWT token
        const user_id = req.user.id;

        // Validate required fields
        if (!name) {
            return res.status(400).json({ error: "Missing name for the location." });
        }
        if (!price_per_night) {
            return res.status(400).json({ error: "Missing price_per_night for the location." });
        }
        if (!address) {
            return res.status(400).json({ error: "Missing latitude or longitude for the location." });
        }
        if (!city || !country) {
            return res.status(400).json({ error: "Missing city or country for the location." });
        }

        let latitude, longitude;
        
        // If manual coordinates are provided, use them
        if (manualLatitude && manualLongitude) {
            latitude = manualLatitude;
            longitude = manualLongitude;
            console.log(`Using manually provided coordinates: ${latitude}, ${longitude}`);
        } else {
            // Geocode the address
            const geocodeResult = await enhancedGeocode(address, city, country);
            
            if (!geocodeResult.success) {
                return res.status(400).json({ 
                    error: "Could not geocode the provided address. Please check the address or provide coordinates manually.",
                    details: geocodeResult.error
                });
            }
            
            latitude = geocodeResult.latitude;
            longitude = geocodeResult.longitude;
            console.log(`Successfully geocoded to: ${latitude}, ${longitude}`);
        }


        connection = await db.getConnection();
        await connection.beginTransaction();

        // Insert new location with additional fields
        const [locationResult] = await connection.query(
            `INSERT INTO Locations 
            (user_id, name, description, address, price_per_night, latitude, longitude, city, country, booking_policy, service_fee_percentage) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

            [user_id, name, description || null, address, price_per_night, latitude, longitude, city, country, booking_policy || null, service_fee_percentage !== undefined ? service_fee_percentage : 10.00] // Added booking_policy and service_fee_percentage
        );

        const location_id = locationResult.insertId;

        // Link location to campsite types
        if (campsite_types && campsite_types.length > 0) {
          // Handle multiple campsite types
          const campsiteTypesPromises = campsite_types.map(type_id => {
            return connection.query(
              'INSERT INTO LocationCampsiteTypes (location_id, campsitetypes_id) VALUES (?, ?)',
              [location_id, parseInt(type_id)]
            );
          });
          await Promise.all(campsiteTypesPromises);
        } 
        else if (campsite_type_id) {
          await connection.query(
            'INSERT INTO LocationCampsiteTypes (location_id, campsitetypes_id) VALUES (?, ?)',
            [location_id, parseInt(campsite_type_id)]
          );
        }

        // Link location to selected amenities
        if (amenities && amenities.length > 0) {
            for (let amenityId of amenities) {
                await connection.query(
                    'INSERT INTO LocationAmenities (location_id, amenity_id) VALUES (?, ?)',
                    [location_id, amenityId]
                );
            }
        }

        await connection.commit();
        res.status(201).json({ message: "Location added successfully!", location_id });

    } catch (err) {
        if (connection) {
            await connection.rollback();
            connection.release();
        }
        res.status(500).json({ error: err.message });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// Filter by needs - Public
router.get('/search', async (req, res) => {
    try {
        const { 
            query, 
            price_min, 
            price_max, 
            amenities,
            campsite_type,
            start_date,
            end_date
        } = req.query;

        let sqlQuery = `
            SELECT DISTINCT l.* 
            FROM Locations l
            LEFT JOIN LocationAmenities la ON l.location_id = la.location_id
            LEFT JOIN LocationCampsiteTypes lct ON l.location_id = lct.location_id
            WHERE 1=1
        `;
        const values = [];

        // Search by query (name, city, country)
        if (query) {
            sqlQuery += ` AND (l.name LIKE ? OR l.city LIKE ? OR l.country LIKE ?)`;
            values.push(`%${query}%`, `%${query}%`, `%${query}%`);
        }

        if (price_min) {
            sqlQuery += ' AND l.price_per_night >= ?';
            values.push(price_min);
        }
        if (price_max) {
            sqlQuery += ' AND l.price_per_night <= ?';
            values.push(price_max);
        }
        if (amenities) {
            sqlQuery += ' AND la.amenity_id IN (?)';
            values.push(amenities.split(','));
        }
        if (campsite_type) {
            sqlQuery += ' AND lct.campsitetypes_id = ?';
            values.push(campsite_type);
        }

        // Filter by availability if dates provided
        if (start_date && end_date) {
            sqlQuery += ` AND l.location_id NOT IN (
                SELECT b.location_id FROM Bookings b
                WHERE 
                -- Existing booking overlaps with requested period
                ((b.start_date <= ? AND b.end_date >= ?) OR 
                 (b.start_date <= ? AND b.end_date >= ?) OR 
                 (b.start_date >= ? AND b.end_date <= ?))
                AND b.status_id != (SELECT status_id FROM Status WHERE status_name = 'cancelled')
            ) AND l.location_id NOT IN (
                SELECT ou.location_id FROM locationunavailabilities ou
                WHERE 
                -- Unavailability period overlaps with requested period
                ((ou.start_date <= ? AND ou.end_date >= ?) OR
                 (ou.start_date <= ? AND ou.end_date >= ?) OR
                 (ou.start_date >= ? AND ou.end_date <= ?))
            )`;
            values.push(
                end_date, start_date, // Booking starts before checkout and ends after checkin
                start_date, start_date, // Booking starts before checkin and ends after checkin
                start_date, end_date,   // Booking is completely within requested period
                end_date, start_date, // Unavailability starts before checkout and ends after checkin
                start_date, start_date, // Unavailability starts before checkin and ends after checkin
                start_date, end_date   // Unavailability is completely within requested period
            );
        }

        console.log('Executing SQL query:', sqlQuery);
        console.log('With values:', values);

        const [locations] = await db.query(sqlQuery, values);
        console.log(`Found ${locations.length} locations`);
        res.json(locations);
    } catch (err) {
        console.error('Error in search endpoint:', err);
        res.status(500).json({ error: err.message });
    }
});

// Owner feats - Protected
router.get('/owner/:userId', authenticateToken, async (req, res) => {
    try {
        //Check if user is requesting their own locations
        if (parseInt(req.user.id) !== parseInt(req.params.userId)) {
            return res.status(403).json({ error: "Access denied: You can only view your own locations" });
        }
        
        const [locations] = await db.query(`
            SELECT
                l.*,
                COALESCE(l.price_per_night, 0) as price_per_night, /* Ensure price_per_night is included */
                COUNT(DISTINCT b_all.booking_id) AS total_bookings, /* Counts all bookings for the location */
                COALESCE(AVG(r.overall_rating), 0) AS average_rating,
                COUNT(DISTINCT r.review_id) AS total_reviews,
                COALESCE((SELECT SUM(bk.total_price)
                    FROM Bookings bk
                    JOIN Status s ON bk.status_id = s.status_id
                    WHERE bk.location_id = l.location_id
                    AND s.status_name = 'completed'
                    AND bk.end_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND CURDATE()
                ), 0) AS earnings_last_week,
                COALESCE((SELECT SUM(bk.total_price)
                    FROM Bookings bk
                    JOIN Status s ON bk.status_id = s.status_id
                    WHERE bk.location_id = l.location_id
                    AND s.status_name = 'completed'
                    AND bk.end_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 1 MONTH) AND CURDATE()
                ), 0) AS earnings_last_month,
                COALESCE((SELECT SUM(bk.total_price)
                    FROM Bookings bk
                    JOIN Status s ON bk.status_id = s.status_id
                    WHERE bk.location_id = l.location_id
                    AND s.status_name = 'completed'
                    AND bk.end_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 1 YEAR) AND CURDATE()
                ), 0) AS earnings_last_year
            FROM Locations l
            LEFT JOIN Bookings b_all ON l.location_id = b_all.location_id /* Alias for total bookings count */
            LEFT JOIN Reviews r ON l.location_id = r.location_id
            WHERE l.user_id = ?
            GROUP BY l.location_id 
            ORDER BY l.created_at DESC
        `, [req.params.userId]);
        
        // Ensure correct data types for numeric fields
        const processedLocations = locations.map(loc => ({
            ...loc,
            price_per_night: parseFloat(parseFloat(loc.price_per_night).toFixed(2)),
            average_rating: parseFloat(parseFloat(loc.average_rating).toFixed(1)), // Typically 1 decimal for rating
            total_reviews: parseInt(loc.total_reviews),
            total_bookings: parseInt(loc.total_bookings),
            earnings_last_week: parseFloat(parseFloat(loc.earnings_last_week).toFixed(2)),
            earnings_last_month: parseFloat(parseFloat(loc.earnings_last_month).toFixed(2)),
            earnings_last_year: parseFloat(parseFloat(loc.earnings_last_year).toFixed(2)),
        }));
        
        res.json(processedLocations);
    } catch (err) {
        console.error("Error fetching owner locations:", err); 
        res.status(500).json({ error: err.message });
    }
});

// Update a location - Protected with ownership check
router.put('/:id', authenticateToken, async (req, res) => {
  let connection; // Declare connection here to be accessible in finally
  try {
    const locationId = req.params.id;
    const {
      name,
      description,
      price_per_night,
      city,
      country,
      latitude,
      longitude,
      address,
      campsite_type_id, // single for backward compatibility
      campsite_types,   // array for multiple
      amenities, // Added for updating amenities
      booking_policy, // Added
      service_fee_percentage, // Added
      images_to_delete  // Array of public_ids of images to delete
    } = req.body;

    connection = await db.getConnection();
    await connection.beginTransaction();

    // Check ownership
    const [locationOwnerRows] = await connection.query(
      'SELECT user_id FROM Locations WHERE location_id = ?',
      [locationId]
    );

    if (locationOwnerRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Location not found' });
    }

    if (locationOwnerRows[0].user_id != req.user.id) {
      await connection.rollback();
      return res.status(403).json({ error: 'Access denied: You can only update your own locations' });
    }

    // Handle image deletions
    if (images_to_delete && Array.isArray(images_to_delete) && images_to_delete.length > 0) {
      for (const publicIdToDelete of images_to_delete) {
        if (publicIdToDelete) {
          // Verify the image belongs to the location before deleting
          const [imageRow] = await connection.query(
            'SELECT image_id FROM Images WHERE public_id = ? AND location_id = ?',
            [publicIdToDelete, locationId]
          );

          if (imageRow.length > 0) {
            // Delete from Cloudinary
            try {
              await cloudinary.uploader.destroy(publicIdToDelete);
              console.log(`Deleted image ${publicIdToDelete} from Cloudinary for location ${locationId}`);
            } catch (cloudinaryError) {
              console.error(`Error deleting image ${publicIdToDelete} from Cloudinary:`, cloudinaryError);
              // Depending on policy, you might want to throw an error here to cause a rollback
            }
            // Delete from database
            await connection.query(
              'DELETE FROM Images WHERE public_id = ? AND location_id = ?',
              [publicIdToDelete, locationId]
            );
            console.log(`Deleted image ${publicIdToDelete} from database for location ${locationId}`);
          } else {
            console.warn(`Image with public_id ${publicIdToDelete} not found for location ${locationId} or does not belong to it. Skipping deletion.`);
          }
        }
      }
    }

    // Update location details
    const updates = [];
    const values = [];

    if (req.body.hasOwnProperty('name')) { updates.push('name = ?'); values.push(name); }
    if (req.body.hasOwnProperty('description')) { updates.push('description = ?'); values.push(description); }
    if (req.body.hasOwnProperty('address')) { updates.push('address = ?'); values.push(address); }
    if (req.body.hasOwnProperty('price_per_night')) { updates.push('price_per_night = ?'); values.push(price_per_night); }
    if (req.body.hasOwnProperty('city')) { updates.push('city = ?'); values.push(city); }
    if (req.body.hasOwnProperty('country')) { updates.push('country = ?'); values.push(country); }
    if (req.body.hasOwnProperty('latitude')) { updates.push('latitude = ?'); values.push(latitude); }
    if (req.body.hasOwnProperty('longitude')) { updates.push('longitude = ?'); values.push(longitude); }
    if (req.body.hasOwnProperty('booking_policy')) { updates.push('booking_policy = ?'); values.push(booking_policy); }
    if (req.body.hasOwnProperty('service_fee_percentage')) { updates.push('service_fee_percentage = ?'); values.push(service_fee_percentage); }

    if (updates.length > 0) {
      const updateValues = [...values, locationId];
      await connection.query(
        `UPDATE Locations SET ${updates.join(', ')} WHERE location_id = ?`,
        updateValues
      );
    }

    // Update campsite types
    // Only update if campsite_types or campsite_type_id is explicitly provided in the request body
    if (req.body.hasOwnProperty('campsite_types')) {
        await connection.query('DELETE FROM LocationCampsiteTypes WHERE location_id = ?', [locationId]);
        if (campsite_types && campsite_types.length > 0) { // campsite_types could be an empty array to clear them
            const campsiteTypesPromises = campsite_types.map(type_id =>
                connection.query('INSERT INTO LocationCampsiteTypes (location_id, campsitetypes_id) VALUES (?, ?)', [locationId, parseInt(type_id)])
            );
            await Promise.all(campsiteTypesPromises);
        }
    } else if (req.body.hasOwnProperty('campsite_type_id')) { // For backward compatibility - single type
        await connection.query('DELETE FROM LocationCampsiteTypes WHERE location_id = ?', [locationId]);
        if (campsite_type_id !== null && campsite_type_id !== undefined && campsite_type_id !== '') { // Ensure it's a valid ID to insert
            await connection.query('INSERT INTO LocationCampsiteTypes (location_id, campsitetypes_id) VALUES (?, ?)', [locationId, parseInt(campsite_type_id)]);
        }
    }
    // If neither campsite_types nor campsite_type_id is in req.body, campsite types are not updated.

    // Update amenities if provided
    if (req.body.hasOwnProperty('amenities')) {
        await connection.query('DELETE FROM LocationAmenities WHERE location_id = ?', [locationId]);
        if (amenities && amenities.length > 0) {
            const amenityPromises = amenities.map(amenity_id =>
                connection.query('INSERT INTO LocationAmenities (location_id, amenity_id) VALUES (?, ?)', [locationId, parseInt(amenity_id)])
            );
            await Promise.all(amenityPromises);
        }
    }

    await connection.commit();
    res.json({ message: 'Location updated successfully' });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Error updating location:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

// Delete a location - Protected with ownership check
router.delete('/:id', authenticateToken, async (req, res) => {
  let connection;
  try {
    const locationId = req.params.id;
    
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Check if the location exists and belongs to the user
    const [location] = await connection.query(
      'SELECT user_id FROM Locations WHERE location_id = ?', 
      [locationId]
    );
    
    if (location.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ error: 'Location not found' });
    }
    
    if (location[0].user_id !== req.user.id) {
      await connection.rollback();
      connection.release();
      return res.status(403).json({ error: 'You can only delete your own locations' });
    }
    
    // Get images to delete from Cloudinary
    const [images] = await connection.query('SELECT public_id FROM Images WHERE location_id = ?', [locationId]);
    
    // Delete images from Cloudinary
    if (images && images.length > 0) {
      for (const image of images) {
        if (image.public_id) {
          try {
            await cloudinary.uploader.destroy(image.public_id);
            console.log(`Deleted image ${image.public_id} from Cloudinary`);
          } catch (cloudinaryError) {
            // Log the error but continue, as we still want to delete the location record
            console.error(`Error deleting image ${image.public_id} from Cloudinary:`, cloudinaryError);
          }
        }
      }
    }
    
    // Delete associated data first
    await connection.query('DELETE FROM LocationAmenities WHERE location_id = ?', [locationId]);
    await connection.query('DELETE FROM LocationCampsiteTypes WHERE location_id = ?', [locationId]);
    // Delete images from database
    await connection.query('DELETE FROM Images WHERE location_id = ?', [locationId]);
    // Delete bookings associated with the location
    // Consider what to do with bookings - for now, let's assume they might need to be archived or handled differently.
    // If direct deletion is required: await connection.query('DELETE FROM Bookings WHERE location_id = ?', [locationId]);
    // Delete reviews associated with the location
    await connection.query('DELETE FROM Reviews WHERE location_id = ?', [locationId]);
    
    // Delete the location
    await connection.query('DELETE FROM Locations WHERE location_id = ?', [locationId]);
    
    await connection.commit();
    res.json({ message: 'Location and associated images deleted successfully' });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Error deleting location:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

// Add amenities to a location
router.post('/:location_id/amenities', authenticateToken, async (req, res) => {
  try {
    const { location_id } = req.params;
    const { amenityIds } = req.body;
    
    if (!Array.isArray(amenityIds)) {
      return res.status(400).json({ error: 'amenityIds must be an array' });
    }
    
    // Verify the location exists and belongs to the user
    const [location] = await db.query(
      'SELECT user_id FROM Locations WHERE location_id = ?',
      [location_id]
    );
    
    if (location.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }
    
    if (location[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only add amenities to your own locations' });
    }
    
    // Delete existing amenities first
    await db.query('DELETE FROM LocationAmenities WHERE location_id = ?', [location_id]);
    
    // Insert each amenity association
    const insertPromises = amenityIds.map(amenity_id => 
      db.query(
        'INSERT INTO LocationAmenities (location_id, amenity_id) VALUES (?, ?)',
        [location_id, amenity_id]
      )
    );
    
    await Promise.all(insertPromises);
    
    res.status(201).json({ message: 'Amenities added successfully' });
  } catch (error) {
    console.error('Error adding amenities:', error);
    if (error.sqlMessage) {
      console.error('SQL Error:', error.sqlMessage);
    }
    res.status(500).json({ 
      error: 'An error occurred while adding amenities',
      details: error.message,
      sqlMessage: error.sqlMessage || 'No SQL details available'
    });
  }
});

router.get('/amenities', async (req, res) => {
  try {

    const [amenities] = await db.query('SELECT amenity_id, name FROM Amenities');
    res.json(amenities);
  } catch (error) {
    console.error('Error fetching amenities:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get locations by user ID
router.get('/user/:user_id', authenticateToken, async (req, res) => {
  try {
    const { user_id } = req.params;
    
    // Ensure the user is requesting their own locations
    if (parseInt(user_id) !== req.user.id) {
      return res.status(403).json({ error: 'You can only view your own locations' });
    }
    
    const [locations] = await db.query(
      `SELECT l.* 
       FROM Locations l 
       WHERE l.user_id = ?`,
      [user_id]
    );
    
    res.json(locations);
  } catch (error) {
    console.error('Error fetching user locations:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all campsite types
router.get('/campsitetypes', async (req, res) => {
  try {
    const [types] = await db.query('SELECT * FROM campsitetypes');
    res.json(types);
  } catch (error) {
    console.error('Error fetching campsite types:', error);
    res.status(500).json({ error: error.message });
  }
});

// Image upload endpoint
router.post('/:location_id/images', authenticateToken, upload.array('images', 10), async (req, res) => {
  let connection;
  try {
    const { location_id } = req.params;
    
    console.log(`Processing image upload for location ${location_id}`);
    
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [location] = await connection.query(
      'SELECT user_id FROM Locations WHERE location_id = ?',
      [location_id]
    );
    
    if (location.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ error: 'Location not found' });
    }
    
    if (location[0].user_id !== req.user.id) {
      await connection.rollback();
      connection.release();
      return res.status(403).json({ error: 'You can only add images to your own locations' });
    }
    
    if (!req.files || req.files.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ error: 'No images uploaded' });
    }
    
    console.log(`Received ${req.files.length} images for Cloudinary upload`);
    
    const imageUploadPromises = req.files.map((file, index) => {
      return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { folder: "location-images" }, // Optional: organize in a Cloudinary folder
          async (error, result) => {
            if (error) {
              console.error('Cloudinary upload error:', error);
              return reject(error);
            }
            const isCover = index === 0 ? 1 : 0;
            console.log(`Uploaded to Cloudinary: ${result.secure_url}, public_id: ${result.public_id}`);
            try {
              const [insertResult] = await connection.query(
                'INSERT INTO Images (image_url, location_id, is_cover, public_id) VALUES (?, ?, ?, ?)',
                [result.secure_url, location_id, isCover, result.public_id]
              );
              resolve(insertResult);
            } catch (dbError) {
              console.error('Database insert error after Cloudinary upload:', dbError);
              // If DB insert fails, try to delete the uploaded image from Cloudinary
              cloudinary.uploader.destroy(result.public_id, (destroyError) => {
                if (destroyError) console.error('Failed to delete orphaned Cloudinary image:', destroyError);
              });
              reject(dbError);
            }
          }
        );
        uploadStream.end(file.buffer);
      });
    });
    
    await Promise.all(imageUploadPromises);
    await connection.commit();
    
    res.status(201).json({ 
      message: 'Images uploaded successfully to Cloudinary and database',
      count: req.files.length
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Detailed error uploading images:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.stack // For more detailed server-side logging
    });
  } finally {
    if (connection) connection.release();
  }
});

// Associate a campsite type with a location
router.post('/:location_id/campsitetype', authenticateToken, async (req, res) => {
  try {
    const { location_id } = req.params;
    const { campsiteTypeId } = req.body;
    
    // Debug log
    console.log(`Adding campsite type ${campsiteTypeId} to location ${location_id}`);
    
    await db.query(
      'INSERT INTO LocationCampsiteTypes (location_id, campsitetypes_id) VALUES (?, ?)',
      [location_id, campsiteTypeId]
    );
    
    res.status(201).json({ message: 'Campsite type associated successfully' });
  } catch (error) {
    console.error('Error associating campsite type:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:location_id/campsitetype', async (req, res) => {
  try {
    const { location_id } = req.params;
    
    const [types] = await db.query(
      `SELECT ct.campsitetypes_id, ct.name
       FROM CampsiteTypes ct
       JOIN LocationCampsiteTypes lct ON ct.campsitetypes_id = lct.campsitetypes_id
       WHERE lct.location_id = ?`,
      [location_id]
    );
    
    res.json(types);
  } catch (error) {
    console.error('Error fetching campsite types for location:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get images for a location
router.get('/:location_id/images', async (req, res) => {
  try {
    const { location_id } = req.params;
    
    const [images] = await db.query(
      'SELECT * FROM Images WHERE location_id = ? ORDER BY is_cover DESC, image_id ASC',
      [location_id]
    );
    
    res.json(images);
  } catch (error) {
    console.error('Error fetching location images:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get amenities for a specific location
router.get('/:location_id/amenities', async (req, res) => {
  try {
    const { location_id } = req.params;
    
    // Log the request to help debug
    console.log(`Fetching amenities for location ${location_id}`);
    
    // First check if the location exists
    const [locationCheck] = await db.query(
      'SELECT location_id FROM Locations WHERE location_id = ?',
      [location_id]
    );
    
    if (locationCheck.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }
    
    // Query to get amenities - FIXED to match your actual column names
    const [amenities] = await db.query(
      `SELECT la.amenity_id, a.name 
       FROM LocationAmenities la
       JOIN Amenities a ON la.amenity_id = a.amenity_id
       WHERE la.location_id = ?`,
      [location_id]
    );
    
    // Log the result to help debug
    console.log(`Found ${amenities.length} amenities for location ${location_id}`);
    
    res.json(amenities);
  } catch (error) {
    console.error('Error fetching location amenities:', error);
    //detailed error information including SQL error
    if (error.sqlMessage) {
      console.error('SQL Error:', error.sqlMessage);
    }
    res.status(500).json({ 
      error: error.message,
      sqlMessage: error.sqlMessage || 'No SQL details available'
    });
  }
});

router.get('/:id/campsitetype', async (req, res) => {
  let connection;
  try {
    const locationId = req.params.id;
    
    connection = await db.getConnection();
    
    // Get all campsite types for this location
    const [types] = await connection.query(
      `SELECT ct.campsitetypes_id, ct.name 
       FROM CampsiteTypes ct
       JOIN LocationCampsiteTypes lct ON ct.campsitetypes_id = lct.campsitetypes_id
       WHERE lct.location_id = ?`,
      [locationId]
    );
    
    res.json(types);
    
  } catch (error) {
    console.error('Error fetching campsite types:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/:id', async (req, res) => {
  let connection;
  try {
    const locationId = req.params.id;
    
    connection = await db.getConnection();
    
    // Get location details
    const [locations] = await connection.query(
      'SELECT * FROM Locations WHERE location_id = ?',
      [locationId]
    );
    
    if (locations.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }
    
    const location = locations[0];
    
    // Get campsite types
    const [campsiteTypes] = await connection.query(
      `SELECT ct.campsitetypes_id, ct.name 
       FROM CampsiteTypes ct
       JOIN LocationCampsiteTypes lct ON ct.campsitetypes_id = lct.campsitetypes_id
       WHERE lct.location_id = ?`,
      [locationId]
    );
    
    location.campsite_types = campsiteTypes;
    
   
    
    res.json(location);
    
  } catch (error) {
    console.error('Error fetching location details:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

// Get a specific location by ID - Public
router.get('/:id', async (req, res) => {
    try {
        const [location] = await db.query(`
            SELECT 
                l.*, 
                COALESCE(AVG(r.overall_rating), 0) as average_rating,
                COALESCE(COUNT(r.review_id), 0) as total_reviews
            FROM Locations l
            LEFT JOIN Reviews r ON l.location_id = r.location_id
            WHERE l.location_id = ?
            GROUP BY l.location_id
        `, [req.params.id]);
        
        if (location.length === 0) {
            return res.status(404).json({ error: 'Location not found' });
        }
        // Ensure numeric types for average_rating
        location[0].average_rating = parseFloat(location[0].average_rating);
        location[0].total_reviews = parseInt(location[0].total_reviews);

        res.json(location[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET all amenities for a specific location
router.get('/:location_id/amenities-for-location', authenticateToken, async (req, res) => {
  const { location_id } = req.params;
  try {
    const query = `
      SELECT a.amenity_id, a.name 
      FROM Amenities a
      JOIN LocationAmenities la ON a.amenity_id = la.amenity_id
      WHERE la.location_id = ?
    `;
    const [amenities] = await db.query(query, [location_id]);
    res.json(amenities);
  } catch (error) {
    console.error('Error fetching amenities for location:', error);
    res.status(500).json({ error: 'Failed to fetch amenities for location' });
  }
});

// GET weekly earnings for a location
router.get('/:location_id/earnings/weekly', authenticateToken, async (req, res) => { // Added authenticateToken
    const { location_id } = req.params;
    // Ensure the user requesting is the owner of the location
    try {
        const [locationOwnerRows] = await db.query(
            'SELECT user_id FROM Locations WHERE location_id = ?',
            [location_id]
        );

        if (locationOwnerRows.length === 0) {
            return res.status(404).json({ error: 'Location not found' });
        }

        if (locationOwnerRows[0].user_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied: You can only view earnings for your own locations' });
        }
    } catch (error) {
        console.error('Error verifying location ownership for earnings:', error);
        return res.status(500).json({ message: 'Error verifying location ownership', error: error.message });
    }


    const connection = await db.getConnection();
    try {
        // Get status_id for 'completed'
        // Corrected to use status_id from Status table schema
        const [statusRows] = await connection.query("SELECT status_id FROM Status WHERE status_name = 'completed' LIMIT 1");
        if (statusRows.length === 0) {
            return res.status(500).json({ message: "Could not find 'completed' status ID." });
        }
        const completedStatusId = statusRows[0].status_id; // Corrected to status_id

        const query = `
            SELECT
                -- Calculate the start of the week (Monday)
                DATE_FORMAT(DATE_SUB(b.end_date, INTERVAL (DAYOFWEEK(b.end_date) - 2) DAY), '%Y-%m-%d') AS week_start_date,
                SUM(b.total_price) AS weekly_earnings
            FROM Bookings b
            WHERE b.location_id = ? AND b.status_id = ?
            GROUP BY week_start_date
            ORDER BY week_start_date ASC;
        `;
        const [earnings] = await connection.query(query, [location_id, completedStatusId]);
        res.json(earnings);
    } catch (error) {
        console.error('Error fetching weekly earnings:', error);
        res.status(500).json({ message: 'Error fetching weekly earnings', error: error.message });
    } finally {
        if (connection) connection.release();
    }
});

// POST to add a new unavailability period for a location
router.post('/:location_id/unavailability', authenticateToken, async (req, res) => {
    const { location_id } = req.params;
    const { start_date, end_date, reason } = req.body;
    const user_id = req.user.id;

    if (!start_date || !end_date) {
        return res.status(400).json({ error: 'Start date and end date are required.' });
    }

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        // Check if the location exists and belongs to the user
        const [locationRows] = await connection.query(
            'SELECT user_id FROM Locations WHERE location_id = ?',
            [location_id]
        );

        if (locationRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Location not found' });
        }

        if (locationRows[0].user_id !== user_id) {
            await connection.rollback();
            return res.status(403).json({ error: 'You can only add unavailability to your own locations' });
        }

        // Insert the unavailability period
        const [result] = await connection.query(
            'INSERT INTO locationunavailabilities (location_id, start_date, end_date, reason) VALUES (?, ?, ?, ?)',
            [location_id, start_date, end_date, reason || null]
        );

        await connection.commit();
        res.status(201).json({ message: 'Unavailability period added successfully', unavailability_id: result.insertId });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Error adding unavailability period:', error); // Keep detailed server log
        // Enhanced error response to client
        res.status(500).json({
            error: 'Failed to add unavailability period',
            details: error.message,
            sqlMessage: error.sqlMessage || 'No SQL details available',
            sqlState: error.sqlState || null,
            errno: error.errno || null
        });
    } finally {
        if (connection) connection.release();
    }
});

// GET all unavailability for a location - Protected
router.get('/:location_id/unavailability', authenticateToken, async (req, res) => {
    const { location_id } = req.params;
    // Ensure the user owns the location or is an admin (if you have admin roles)
    // For simplicity, this example assumes the user owns the location if they can access this route after auth.
    // You might want to add a specific check:
    // const [loc] = await db.query('SELECT user_id FROM Locations WHERE location_id = ?', [location_id]);
    // if (!loc.length || loc[0].user_id !== req.user.id) {
    //   return res.status(403).json({ error: "Access denied or location not found." });
    // }

    try {
        const [unavailabilities] = await db.query(
            'SELECT * FROM locationunavailabilities WHERE location_id = ? ORDER BY start_date ASC',
            [location_id]
        );
        res.json(unavailabilities);
    } catch (err) {
        console.error("Error fetching unavailabilities:", err);
        res.status(500).json({ error: err.message, sqlMessage: err.sqlMessage, sqlState: err.sqlState, errno: err.errno });
    }
});

// DELETE an unavailability period - Protected
router.delete('/:location_id/unavailability/:unavailability_id', authenticateToken, async (req, res) => {
    const { location_id, unavailability_id } = req.params;
    let connection;

    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        // Optional: Verify the location exists and the user owns it
        const [locationRows] = await connection.query('SELECT user_id FROM Locations WHERE location_id = ?', [location_id]);
        if (locationRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Location not found.' });
        }
        if (locationRows[0].user_id !== req.user.id) {
            await connection.rollback();
            return res.status(403).json({ error: 'Access denied. You do not own this location.' });
        }

        // Verify the unavailability period belongs to the location
        const [unavailabilityRows] = await connection.query(
            'SELECT unavailability_id FROM locationunavailabilities WHERE unavailability_id = ? AND location_id = ?',
            [unavailability_id, location_id]
        );

        if (unavailabilityRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Unavailability period not found for this location.' });
        }

        await connection.query('DELETE FROM locationunavailabilities WHERE unavailability_id = ?', [unavailability_id]);
        await connection.commit();
        res.json({ message: 'Unavailability period deleted successfully.' });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error("Error deleting unavailability:", err);
        res.status(500).json({ error: err.message, sqlMessage: err.sqlMessage, sqlState: err.sqlState, errno: err.errno });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;