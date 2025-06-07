const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { authenticateToken } = require('../middleware/jwt');
const db = require('../config/db');
const cloudinary = require('../config/cloudinary'); // Import Cloudinary config

// Configure Multer for memory storage
const storage = multer.memoryStorage(); // Use memoryStorage for Cloudinary
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

        if (!user_id) { // user_id is always required
            return res.status(400).json({ error: 'User ID is required in the request body.' });
        }

        // Fetch user data from the database by user_id
        const [userData] = await db.query('SELECT * FROM Users WHERE user_id = ?', [user_id]);

        if (userData.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const user = userData[0];

        // Conditional password validation based on auth_type
        if (user.auth_type !== 'google') { // Assuming 'google' is your OAuth type. Adjust if other OAuth types exist.
            if (!password) {
                return res.status(400).json({ error: 'Password is required to delete this account.' });
            }
            // Ensure user.password exists before comparing (it should for 'local' auth_type)
            if (!user.password) {
                console.error(`User ${user_id} with auth_type ${user.auth_type} has no password hash.`);
                return res.status(500).json({ error: 'Cannot verify password; account data inconsistent.' });
            }
            const isPasswordValid = await bcrypt.compare(password, user.password);
            if (!isPasswordValid) {
                return res.status(401).json({ error: 'Incorrect password.' });
            }
        }
        // For 'google' (OAuth) users, password check is skipped.
        // Authorization is based on JWT and matching user_id.
        
        // If user has profile picture, delete it from Cloudinary (if applicable)
        if (user.profile_picture_url && user.profile_picture_url.includes('cloudinary')) {
            try {
                // Extract public_id from the Cloudinary URL
                const parts = user.profile_picture_url.split('/');
                const publicIdWithFolder = parts.slice(parts.indexOf('upload') + 2).join('/').replace(/\\.[^/.]+$/, "");

                if (publicIdWithFolder) {
                    await cloudinary.uploader.destroy(publicIdWithFolder);
                    console.log(`Deleted profile picture ${publicIdWithFolder} from Cloudinary for user ${user_id}`);
                }
            } catch (cloudinaryError) {
                console.error(`Failed to delete profile picture from Cloudinary for user ${user_id}:`, cloudinaryError);
                // Log error but don't fail the request, as account deactivation is the primary goal.
            }
        }
        // Note: Deletion of local profile pictures (if any) is removed as Cloudinary is primary.
        
        // Soft delete the user by marking them as inactive
        await db.query(
            'UPDATE Users SET is_active = ?, status = ? WHERE user_id = ?',
            [false, 'inactive', user_id]
        );
            
        res.json({ message: 'Account deactivated successfully.' });

    } catch (err) {
        // Enhanced error logging for the outer catch block
        console.error('Failed to deactivate account:', err);
        res.status(500).json({ 
            error: 'Failed to deactivate account.', 
            details: err.message, 
            sqlState: err.sqlState, // Include SQL-specific error info if available
            errno: err.errno       // Include SQL-specific error info if available
        });
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

    // Get current profile picture before updating to delete it from Cloudinary if it exists
    const [currentUser] = await db.query('SELECT profile_picture_url FROM Users WHERE user_id = ?', [userId]);
    const oldProfilePictureUrl = currentUser[0]?.profile_picture_url;

    // Upload to Cloudinary
    cloudinary.uploader.upload_stream({ folder: "profile-pictures" }, async (error, result) => {
      if (error) {
        console.error('Cloudinary upload error:', error);
        return res.status(500).json({ error: 'Failed to upload image to Cloudinary.' });
      }

      const profilePictureCloudinaryUrl = result.secure_url;
      // const publicId = result.public_id; // Optional: Store public_id to be able to delete later

      await db.query('UPDATE Users SET profile_picture_url = ? WHERE user_id = ?', [profilePictureCloudinaryUrl, userId]);
      
      if (oldProfilePictureUrl && oldProfilePictureUrl.includes('cloudinary.com')) {
        try {
          const parts = oldProfilePictureUrl.split('/');
          const versionAndPublicIdWithExt = parts.slice(parts.indexOf('upload') + 2).join('/');
          const publicIdToDelete = versionAndPublicIdWithExt.substring(0, versionAndPublicIdWithExt.lastIndexOf('.'));
          if (publicIdToDelete) {
            await cloudinary.uploader.destroy(publicIdToDelete);
            console.log('Old profile picture deleted from Cloudinary:', publicIdToDelete);
          }
        } catch (deleteError) {
          console.error('Failed to delete old profile picture from Cloudinary:', deleteError);
        }
      } else if (oldProfilePictureUrl) {
        const oldPicturePath = path.join(__dirname, '..', oldProfilePictureUrl);
        if (fs.existsSync(oldPicturePath)) {
          fs.unlinkSync(oldPicturePath);
        }
      }
      
      res.status(200).json({ 
        message: 'Profile picture updated successfully',
        profile_picture_url: profilePictureCloudinaryUrl
      });
    }).end(req.file.buffer);

  } catch (err) {
    console.error('Error updating profile picture:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add new route for REMOVING profile pictures
router.delete('/:id/profile-picture', authenticateToken, async (req, res) => {
  try {
    // Check if user is updating their own profile
    if (req.user.id != req.params.id) {
      return res.status(403).json({ error: "Access denied: You can only update your own profile" });
    }
    
    const userId = req.params.id;

    // Get current profile picture to delete it from Cloudinary
    const [currentUser] = await db.query('SELECT profile_picture_url FROM Users WHERE user_id = ?', [userId]);
    const currentProfilePictureUrl = currentUser[0]?.profile_picture_url;

    if (!currentProfilePictureUrl) {
      return res.status(404).json({ error: 'No profile picture to remove.' });
    }

    // Update database first
    await db.query('UPDATE Users SET profile_picture_url = NULL WHERE user_id = ?', [userId]);

    // If the picture was on Cloudinary, delete it from there
    if (currentProfilePictureUrl.includes('cloudinary.com')) {
      try {
        // Extract public_id from the Cloudinary URL
        // Example URL: http://res.cloudinary.com/your_cloud_name/image/upload/v1234567890/profile-pictures/public_id.jpg
        const parts = currentProfilePictureUrl.split('/');
        // The public_id is typically the last part before the extension, within its folder structure
        // For "profile-pictures/image_id.jpg", public_id is "profile-pictures/image_id"
        const publicIdWithFolder = parts.slice(parts.indexOf('upload') + 2).join('/').replace(/\\.[^/.]+$/, "");

        if (publicIdWithFolder) {
          await cloudinary.uploader.destroy(publicIdWithFolder);
          console.log('Profile picture deleted from Cloudinary:', publicIdWithFolder);
        }
      } catch (deleteError) {
        console.error('Failed to delete profile picture from Cloudinary:', deleteError);
        // Log error but don't fail the request if DB update was successful
      }
    } else {
      // Handle deletion from local file system if it was a local path (legacy or fallback)
      const oldPicturePath = path.join(__dirname, '..', currentProfilePictureUrl);
      if (fs.existsSync(oldPicturePath)) {
        fs.unlinkSync(oldPicturePath);
         console.log('Old profile picture deleted from local file system:', oldPicturePath);
      }
    }
    
    res.status(200).json({ 
      message: 'Profile picture removed successfully'
    });

  } catch (err) {
    console.error('Error removing profile picture:', err);
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