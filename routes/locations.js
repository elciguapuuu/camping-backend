const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticateToken } = require('../middleware/jwt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure storage
const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    
    const uploadDir = path.join(__dirname, '../uploads/location-images');
    
    //create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    
    cb(null, uploadDir);
  },
  filename: function(req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

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
            campsite_type_id, 
            amenities, 
            price_per_night, 
            latitude, 
            longitude, 
            city, 
            country 
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
        if (!latitude || !longitude) {
            return res.status(400).json({ error: "Missing latitude or longitude for the location." });
        }
        if (!city || !country) {
            return res.status(400).json({ error: "Missing city or country for the location." });
        }

        connection = await db.getConnection();
        await connection.beginTransaction();

        // Insert new location with additional fields
        const [locationResult] = await connection.query(
            `INSERT INTO Locations 
            (user_id, name, description, price_per_night, latitude, longitude, city, country) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [user_id, name, description || null, price_per_night, latitude, longitude, city, country]
        );

        const location_id = locationResult.insertId;

        // Link location to campsite type
        if (campsite_type_id) {
            await connection.query(
                'INSERT INTO LocationCampsiteTypes (location_id, campsite_type_id) VALUES (?, ?)',
                [location_id, campsite_type_id]
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
            price_min, 
            price_max, 
            amenities,
            campsite_type,
            city,
            country 
        } = req.query;

        let query = `
            SELECT DISTINCT l.* 
            FROM Locations l
            LEFT JOIN LocationAmenities la ON l.location_id = la.location_id
            LEFT JOIN LocationCampsiteTypes lct ON l.location_id = lct.location_id
            WHERE 1=1
        `;
        const values = [];

        if (price_min) {
            query += ' AND l.price_per_night >= ?';
            values.push(price_min);
        }
        if (price_max) {
            query += ' AND l.price_per_night <= ?';
            values.push(price_max);
        }
        if (amenities) {
            query += ' AND la.amenity_id IN (?)';
            values.push(amenities.split(','));
        }
        if (campsite_type) {
            query += ' AND lct.campsite_type_id = ?';
            values.push(campsite_type);
        }
        if (city) {
            query += ' AND l.city LIKE ?';
            values.push(`%${city}%`);
        }
        if (country) {
            query += ' AND l.country LIKE ?';
            values.push(`%${country}%`);
        }

        const [locations] = await db.query(query, values);
        res.json(locations);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Owner feats - Protected
router.get('/owner/:userId', authenticateToken, async (req, res) => {
    try {
        //Check if user is requesting their own locations
        if (req.user.id != req.params.userId) {
            return res.status(403).json({ error: "Access denied: You can only view your own locations" });
        }
        
        const [locations] = await db.query(`
            SELECT l.*, 
                   COUNT(DISTINCT b.booking_id) as total_bookings,
                   COUNT(DISTINCT r.review_id) as total_reviews,
                   AVG(r.overall_rating) as average_rating
            FROM Locations l
            LEFT JOIN Bookings b ON l.location_id = b.location_id
            LEFT JOIN Reviews r ON l.location_id = r.location_id
            WHERE l.user_id = ?
            GROUP BY l.location_id
        `, [req.params.userId]);
        
        res.json(locations);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update a location - Protected with ownership check
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const locationId = req.params.id;
    const { 
      name, 
      description, 
      price_per_night, 
      city,
      country,
      latitude,
      longitude
    } = req.body;
    
    // Check ownership
    const [locationOwner] = await db.query(
      'SELECT user_id FROM Locations WHERE location_id = ?',
      [locationId]
    );
    
    if (locationOwner.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }
    
    if (locationOwner[0].user_id != req.user.id) {
      return res.status(403).json({ error: 'Access denied: You can only update your own locations' });
    }
    
    //update querys
    const updates = [];
    const values = [];
    
    if (name) {
      updates.push('name = ?');
      values.push(name);
    }
    if (description) {
      updates.push('description = ?');
      values.push(description);
    }
    if (price_per_night) {
      updates.push('price_per_night = ?');
      values.push(price_per_night);
    }
    if (city) {
      updates.push('city = ?');
      values.push(city);
    }
    if (country) {
      updates.push('country = ?');
      values.push(country);
    }
    if (latitude) {
      updates.push('latitude = ?');
      values.push(latitude);
    }
    if (longitude) {
      updates.push('longitude = ?');
      values.push(longitude);
    }
    
    //proceed if there are updates
    if (updates.length > 0) {
      values.push(locationId);
      await db.query(
        `UPDATE Locations SET ${updates.join(', ')} WHERE location_id = ?`, 
        values
      );
    }
    
    res.json({ message: 'Location updated successfully' });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a location - Protected with ownership check
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const locationId = req.params.id;
    
    // Check if the location exists and belongs to the user
    const [location] = await db.query(
      'SELECT user_id FROM Locations WHERE location_id = ?', 
      [locationId]
    );
    
    if (location.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }
    
    if (location[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete your own locations' });
    }
    
    // Delete associated data first
    await db.query('DELETE FROM LocationAmenities WHERE location_id = ?', [locationId]);
    await db.query('DELETE FROM LocationCampsiteTypes WHERE location_id = ?', [locationId]);
    
    // Get images to delete files
    const [images] = await db.query('SELECT * FROM Images WHERE location_id = ?', [locationId]);
    
    // Delete image files
    for (const image of images) {
      const imagePath = path.join(__dirname, '..', image.image_url);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }
    
    // Delete images from database
    await db.query('DELETE FROM Images WHERE location_id = ?', [locationId]);
    
    // Delete the location
    await db.query('DELETE FROM Locations WHERE location_id = ?', [locationId]);
    
    res.json({ message: 'Location deleted successfully' });
  } catch (error) {
    console.error('Error deleting location:', error);
    res.status(500).json({ error: error.message });
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
  try {
    const { location_id } = req.params;
    
    //debug log to help troubleshoot
    console.log(`Processing image upload for location ${location_id}`);
    
    // Verify the location exists and belongs to the user
    const [location] = await db.query(
      'SELECT user_id FROM Locations WHERE location_id = ?',
      [location_id]
    );
    
    if (location.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }
    
    if (location[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only add images to your own locations' });
    }
    
    // Process uploaded files
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded' });
    }
    
    console.log(`Received ${req.files.length} images for upload`);
    
    // Insert image records into database
    
    const imageInsertPromises = req.files.map((file, index) => {
        const imagePath = `/uploads/location-images/${file.filename}`;
      // Set the first image as the cover image (is_cover = 1)
      const isCover = index === 0 ? 1 : 0;
      
      console.log(`Adding image: ${imagePath}, is_cover: ${isCover}`);
      
      return db.query(
        'INSERT INTO Images (image_url, location_id, is_cover) VALUES (?, ?, ?)',
        [imagePath, location_id, isCover]
      );
    });
    
    await Promise.all(imageInsertPromises);
    
    res.status(201).json({ 
      message: 'Images uploaded successfully',
      count: req.files.length
    });
  } catch (error) {
    console.error('Detailed error uploading images:', error);
    // Send more details to help debugging
    res.status(500).json({ 
      error: error.message,
      sqlMessage: error.sqlMessage || 'No SQL message available',
      errorCode: error.code || 'No error code available'
    });
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

module.exports = router;