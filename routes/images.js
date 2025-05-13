const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../config/db');
const { authenticateToken } = require('../middleware/jwt');
const cloudinary = require('../config/cloudinary'); // Import Cloudinary config

// Configure Multer for memory storage
const storage = multer.memoryStorage(); // Use memoryStorage for Cloudinary
const upload = multer({ storage: storage });

// Route for uploading an image - Protected
router.post('/upload', authenticateToken, upload.single('image'), async (req, res) => {
    try {
      const { location_id, is_cover } = req.body;
      if (!location_id) {
        return res.status(400).json({ error: 'Location ID is required.' });
      }
  
      if (!req.file) {
        return res.status(400).json({ error: 'No image file provided.' });
      }
      
      const [locationOwnerRows] = await db.query(
          'SELECT user_id FROM Locations WHERE location_id = ?',
          [location_id]
      );
      
      if (locationOwnerRows.length === 0) {
          return res.status(404).json({ error: 'Location not found' });
      }
      
      if (locationOwnerRows[0].user_id != req.user.id) {
          return res.status(403).json({ error: 'Access denied: You can only upload images to your own locations' });
      }
  
      // Upload to Cloudinary
      cloudinary.uploader.upload_stream({ folder: "location-images" }, async (error, result) => {
        if (error) {
          console.error('Cloudinary upload error:', error);
          return res.status(500).json({ error: 'Failed to upload image to Cloudinary.' });
        }

        const cloudinaryUrl = result.secure_url;
        const publicId = result.public_id; // e.g., "location-images/random_string"

        // Assumes `public_id` column exists in Images table
        const [dbResult] = await db.query(
          'INSERT INTO Images (image_url, location_id, is_cover, public_id) VALUES (?, ?, ?, ?)',
          [cloudinaryUrl, location_id, is_cover ? 1 : 0, publicId]
        );
    
        res.status(201).json({ 
          message: 'Image uploaded successfully!', 
          image_id: dbResult.insertId, 
          image_url: cloudinaryUrl,
          public_id: publicId
        });
      }).end(req.file.buffer);

    } catch (err) {
      console.error('Error uploading location image:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Internal server error during image upload.' });
      }
    }
});
  
// deleting an image - Protected
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const imageId = req.params.id;
    const [imageRows] = await db.query(
      'SELECT i.image_url, i.public_id, l.user_id as location_owner_id FROM Images i JOIN Locations l ON i.location_id = l.location_id WHERE i.image_id = ?',
      [imageId]
    );
    
    if (imageRows.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const image = imageRows[0];
    
    if (image.location_owner_id != req.user.id) {
      return res.status(403).json({ error: 'Access denied: You can only delete images from your own locations' });
    }
    
    // Delete from Cloudinary using stored public_id
    if (image.public_id) {
      try {
        await cloudinary.uploader.destroy(image.public_id);
        console.log('Image deleted from Cloudinary using public_id:', image.public_id);
      } catch (deleteError) {
        console.error('Failed to delete image from Cloudinary using public_id:', image.public_id, deleteError);
        // Continue to attempt DB deletion even if Cloudinary deletion fails, to avoid orphaned DB records.
        // The image might have been manually deleted from Cloudinary.
      }
    } else if (image.image_url && image.image_url.includes('cloudinary.com')) {
      // Fallback: If public_id is not stored, try to parse from URL
      try {
        const urlParts = image.image_url.split('/');
        const uploadIndex = urlParts.indexOf('upload');
        if (uploadIndex !== -1 && uploadIndex < urlParts.length - 1) {
          let pathAfterUpload = urlParts.slice(uploadIndex + 1);
          if (pathAfterUpload.length > 0 && pathAfterUpload[0].match(/^v\d+$/)) {
              pathAfterUpload = pathAfterUpload.slice(1);
          }
          if (pathAfterUpload.length > 0) {
            const publicIdWithExtension = pathAfterUpload.join('/');
            const publicIdToDelete = publicIdWithExtension.substring(0, publicIdWithExtension.lastIndexOf('.'));
            if (publicIdToDelete) {
              await cloudinary.uploader.destroy(publicIdToDelete);
              console.log('Image deleted from Cloudinary by parsing URL:', publicIdToDelete);
            }
          }
        }
      } catch (deleteError) {
        console.error('Failed to delete image from Cloudinary by parsing URL:', image.image_url, deleteError);
      }
    } else if (image.image_url) {
      // Fallback: Local file deletion for very old images
      const localImagePath = path.join(__dirname, '..', image.image_url);
      if (fs.existsSync(localImagePath)) {
        try {
          fs.unlinkSync(localImagePath);
          console.log('Legacy local file deleted:', localImagePath);
        } catch (unlinkError) {
          console.error('Failed to delete legacy local file:', unlinkError);
        }
      }
    }
    
    await db.query('DELETE FROM Images WHERE image_id = ?', [imageId]);
    
    res.json({ message: 'Image deleted successfully' });
  } catch (err) {
    console.error('Error deleting image:', err);
    if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Internal server error during image deletion.' });
    }
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
