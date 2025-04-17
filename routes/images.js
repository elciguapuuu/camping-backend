const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../config/db');
const { authenticateToken } = require('../middleware/jwt');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/images');
  },
  filename: (req, file, cb) => {
    
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// Route for uploading an image - Protected
router.post('/upload', authenticateToken, upload.single('image'), async (req, res) => {
    try {
      console.log(req.file); 
      const { location_id, is_cover } = req.body;
      if (!location_id) {
        return res.status(400).json({ error: 'Location ID is required.' });
      }
  
      if (!req.file) {
        return res.status(400).json({ error: 'No image file provided.' });
      }
      
      // Check if user owns this location
      const [locationOwner] = await db.query(
          'SELECT user_id FROM Locations WHERE location_id = ?',
          [location_id]
      );
      
      if (locationOwner.length === 0) {
          return res.status(404).json({ error: 'Location not found' });
      }
      
      if (locationOwner[0].user_id != req.user.id) {
          return res.status(403).json({ error: 'Access denied: You can only upload images to your own locations' });
      }
  
      const imageUrl = `/uploads/images/${req.file.filename}`;
  
      const [result] = await db.query(
        'INSERT INTO Images (image_url, location_id, is_cover) VALUES (?, ?, ?)',
        [imageUrl, location_id, is_cover ? true : false]
      );
  
      res.status(201).json({ 
        message: 'Image uploaded successfully!', 
        image_id: result.insertId, 
        image_url: imageUrl 
      });

    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  
// deleting an image - Protected
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    // First, get the image details from the database
    const [images] = await db.query(`
      SELECT i.*, l.user_id as location_owner_id 
      FROM Images i
      JOIN Locations l ON i.location_id = l.location_id
      WHERE i.image_id = ?`, 
      [req.params.id]
    );
    
    if (images.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const image = images[0];
    
    // Check if user owns the location this image belongs to
    if (image.location_owner_id != req.user.id) {
      return res.status(403).json({ error: 'Access denied: You can only delete images from your own locations' });
    }
    
    // Get the full path of the image file from the database
    const imageRelativePath = image.image_url; // Get the stored path
    const imagePath = path.join(__dirname, '..', imageRelativePath);
    
    console.log('Attempting to delete file at:', imagePath);
    
    // Delete the file if it exists
    if (fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
      console.log('File deleted successfully');
    } else {
      console.log('File not found at path:', imagePath);
    }
    
    // Delete the database record
    await db.query('DELETE FROM Images WHERE image_id = ?', [req.params.id]);
    
    res.json({ message: 'Image deleted successfully' });
  } catch (err) {
    console.error('Error deleting image:', err);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

// Get images for a specific location
router.get('/location/:location_id', async (req, res) => {
  try {
    const [images] = await db.query(
      'SELECT * FROM Images WHERE location_id = ? ORDER BY is_cover DESC, image_id ASC',
      [req.params.location_id]
    );
    
    res.json(images);
  } catch (err) {
    console.error('Error fetching location images:', err);
    res.status(500).json({ error: 'Failed to fetch images' });
  }
});

module.exports = router;
