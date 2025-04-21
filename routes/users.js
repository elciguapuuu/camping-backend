const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { authenticateToken } = require('../middleware/jwt');
const db = require('../config/db');

// Set up storage for profile pictures
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/profiles';
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)){
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'profile-' + uniqueSuffix + ext);
  }
});

const upload = multer({ storage: storage });

// Get all users - Protected admin route
router.get('/', authenticateToken, async (req, res) => {
    try {
        const [users] = await db.query('SELECT * FROM Users');
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get user by ID - Protected (users should only access their own profiles)
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        // Check if user is requesting their own profile
        if (req.user.id != req.params.id) {
            return res.status(403).json({ error: "Access denied: You can only view your own profile" });
        }
        
        const [users] = await db.query(
            'SELECT user_id, name, email, profile_picture_url, auth_type FROM Users WHERE user_id = ?', 
            [req.params.id]
        );
        
        if (users.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }
        
        res.json(users[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update user/ change credentials - Protected
router.put('/:id', authenticateToken, async (req, res) => {
    try {
        // Check if user is updating their own profile
        if (req.user.id != req.params.id) {
            return res.status(403).json({ error: "Access denied: You can only update your own profile" });
        }
        
        const { name, email, current_password, new_password } = req.body;
        const userId = req.params.id;

        const [user] = await db.query('SELECT * FROM Users WHERE user_id = ?', [userId]);
        if (user.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Check if this is an OAuth user
        const isOAuthUser = user[0].auth_type === 'google';
        
        // If changing password but user is OAuth, return error
        if (new_password && isOAuthUser) {
            return res.status(400).json({ error: 'Password cannot be changed for OAuth accounts' });
        }
        
        // If trying to change email but user is OAuth, return error
        if (email && isOAuthUser && email !== user[0].email) {
            return res.status(400).json({ error: 'Email cannot be changed for OAuth accounts' });
        }
        
        // Only verify password for non-OAuth users
        if (!isOAuthUser && new_password) {
            const validPassword = await bcrypt.compare(current_password, user[0].password);
            if (!validPassword) {
                return res.status(401).json({ error: 'Current password is incorrect' });
            }
        }

        const updates = [];
        const values = [];

        if (name) {
            updates.push('name = ?');
            values.push(name);
        }
        if (email) {
            updates.push('email = ?');
            values.push(email);
        }
        if (new_password) {
            updates.push('password = ?');
            values.push(await bcrypt.hash(new_password, 10));
        }

        if (updates.length > 0) {
            values.push(userId);
            await db.query(
                `UPDATE Users SET ${updates.join(', ')} WHERE user_id = ?`,
                values
            );
        }

        res.json({ message: 'User updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete user - Protected
router.delete('/delete', authenticateToken, async (req, res) => {
    try {
        const { user_id, password } = req.body;

        // Check if user is deleting their own account
        if (req.user.id != user_id) {
            return res.status(403).json({ error: "Access denied: You can only delete your own account" });
        }

        if (!user_id || !password) {
            return res.status(400).json({ error: 'User ID and password are required.' });
        }

        // Fetch user data from the database by user_id
        const [userData] = await db.query('SELECT * FROM Users WHERE user_id = ?', [user_id]);

        if (userData.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const user = userData[0];

        // Compare the provided password with the stored hashed password
        const isPasswordValid = await bcrypt.compare(password, user.password);
        
        if (!isPasswordValid) {
            return res.status(401).json({ error: 'Incorrect password.' });
        }
        
        // If user has profile picture, delete it
        if (user.profile_picture_url) {
            const imagePath = path.join(__dirname, '..', user.profile_picture_url);
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }
        }
        
       
        const connection = await db.getConnection();
        await connection.beginTransaction();
        
        try {
            // Delete user's reviews
            await connection.query('DELETE FROM Reviews WHERE user_id = ?', [user_id]);
            
            // Delete user's bookings
            await connection.query('DELETE FROM Bookings WHERE user_id = ?', [user_id]);
            
            // For locations owned by this user:
            // 1. Get all locations owned by the user
            const [locations] = await connection.query('SELECT location_id FROM Locations WHERE user_id = ?', [user_id]);
            
            // 2. For each location, delete associated records
            for (const location of locations) {
                const locationId = location.location_id;
                
                // Delete location amenities
                await connection.query('DELETE FROM LocationAmenities WHERE location_id = ?', [locationId]);
                
                // Delete location campsite types
                await connection.query('DELETE FROM LocationCampsiteTypes WHERE location_id = ?', [locationId]);
                
                // Get images to delete files
                const [images] = await connection.query('SELECT * FROM Images WHERE location_id = ?', [locationId]);
                
                // Delete image files
                for (const image of images) {
                    const imagePath = path.join(__dirname, '..', image.image_url);
                    if (fs.existsSync(imagePath)) {
                        fs.unlinkSync(imagePath);
                    }
                }
                
                // Delete images from database
                await connection.query('DELETE FROM Images WHERE location_id = ?', [locationId]);
            }
            
            // Delete all locations owned by the user
            await connection.query('DELETE FROM Locations WHERE user_id = ?', [user_id]);
            
            // Finally delete the user
            await connection.query('DELETE FROM Users WHERE user_id = ?', [user_id]);
            
            await connection.commit();
            
            res.json({ message: 'Account deleted successfully.' });
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add new route for uploading profile pictures
router.post('/:id/profile-picture', authenticateToken, upload.single('profile_picture'), async (req, res) => {
  try {
    // Check if user is updating their own profile
    if (req.user.id != req.params.id) {
      return res.status(403).json({ error: "Access denied: You can only update your own profile" });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided.' });
    }
    
    const userId = req.params.id;
    const profilePictureUrl = `/uploads/profile-pictures/${req.file.filename}`;
    
    // Get current profile picture before updating
    const [currentUser] = await db.query('SELECT profile_picture_url FROM Users WHERE user_id = ?', [userId]);
    const oldProfilePicture = currentUser[0]?.profile_picture_url;
    
    // Update user's profile picture in database
    await db.query('UPDATE Users SET profile_picture_url = ? WHERE user_id = ?', [profilePictureUrl, userId]);
    
    // Remove old profile picture if it exists
    if (oldProfilePicture) {
      const oldPicturePath = path.join(__dirname, '..', oldProfilePicture);
      if (fs.existsSync(oldPicturePath)) {
        fs.unlinkSync(oldPicturePath);
      }
    }
    
    res.status(200).json({ 
      message: 'Profile picture updated successfully',
      profile_picture_url: profilePictureUrl
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// New endpoint: Get current user profile
router.get('/me/profile', authenticateToken, async (req, res) => {
  try {
    const [users] = await db.query(
      'SELECT user_id, name, email, auth_type, profile_picture_url FROM users WHERE user_id = ?',
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = users[0];
    res.json(user);
  } catch (err) {
    console.error('Error getting current user profile:', err);
    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

module.exports = router;
