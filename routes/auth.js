const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../config/db');
const passport = require('passport');
const jwt = require('jsonwebtoken');

// Secret key for JWT - ideally store this in environment variables
const JWT_SECRET = process.env.JWT_SECRET || 'your-camping-app-secret-key'; 

// Email and password validation functions
const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

const isValidPassword = (password) => {
    // At least 8 characters, 1 uppercase, 1 lowercase, 1 number, 1 special character from an expanded set
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_\-+=\[\]{};':"\\|,.<>\/?~])[A-Za-z\d!@#$%^&*()_\-+=\[\]{};':"\\|,.<>\/?~]{8,}$/;
    return passwordRegex.test(password);
};

// Helper function to generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    { 
      id: user.id || user.user_id, 
      email: user.email,
      name: user.name
    }, 
    JWT_SECRET, 
    { expiresIn: '24h' }
  );
};

// Register route
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    
    // Validate required fields
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Validate email format
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Validate password complexity
    if (!isValidPassword(password)) {
      return res.status(400).json({ 
        error: 'Password must be at least 8 characters long and include at least one uppercase letter, one lowercase letter, one number, and one special character.' 
      });
    }
    
    // Check if email already exists
    const [existingUsers] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    
    if (existingUsers.length > 0) {
      return res.status(400).json({ error: 'Email already in use' });
    }
    
    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    // Insert new user
    const [result] = await db.query(
      'INSERT INTO users (name, email, password, auth_type) VALUES (?, ?, ?, ?)',
      [name, email, hashedPassword, 'local']
    );
    
    const userId = result.insertId;
    
    // Generate JWT
    const token = jwt.sign(
      { id: userId, email }, 
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    // Get the newly created user (to include all fields)
    const [newUsers] = await db.query(
      'SELECT user_id, name, email, auth_type, profile_picture_url FROM users WHERE user_id = ?',
      [userId]
    );
    
    if (newUsers.length === 0) {
      return res.status(500).json({ error: 'User creation failed' });
    }
    
    const user = newUsers[0];
    
    res.status(201).json({ 
      token,
      user: {
        id: user.user_id,
        name: user.name,
        email: user.email,
        profile_picture_url: user.profile_picture_url
      }
    });
    
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login route
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Validate required fields
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    // Find user by email
    const [users] = await db.query(
      'SELECT user_id, name, email, password, auth_type, profile_picture_url FROM users WHERE email = ?', 
      [email]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const user = users[0];
    
    // Check if this is a local user account (not OAuth)
    if (user.auth_type !== 'local') {
      return res.status(401).json({ 
        error: `Please sign in with ${user.auth_type} instead` 
      });
    }
    
    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Generate JWT
    const token = jwt.sign(
      { id: user.user_id, email: user.email }, 
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    // Return token and user data (without password)
    delete user.password;
    
    res.json({ 
      token,
      user: {
        id: user.user_id,
        name: user.name,
        email: user.email,
        profile_picture_url: user.profile_picture_url
      }
    });
    
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Google OAuth routes
router.get('/google',
    passport.authenticate('google', { 
      scope: ['profile', 'email']
    })
  );
  
  
router.get('/google/callback',
  passport.authenticate('google', { 
    failureRedirect: '/login',
    session: true
  }),
  async (req, res) => {
    try {
      // Generate JWT token for Google authenticated user
      const token = generateToken(req.user);
      
      // Redirect to frontend with token and additional auth_success flag
      res.redirect(`http://localhost:8080/?token=${token}&userId=${req.user.user_id}&name=${encodeURIComponent(req.user.name)}&email=${encodeURIComponent(req.user.email)}&auth_success=true`);
    } catch (err) {
      res.redirect('http://localhost:8080/login?error=Authentication+failed');
    }
  }
);

module.exports = router;