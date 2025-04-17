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
    // At least 8 characters, 1 uppercase, 1 lowercase, 1 number, 1 special character
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
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

router.post('/register', async (req, res) => {
    const { name, email, password } = req.body;

    // Validate input
    if (!name || name.length < 2) {
        return res.status(400).json({ error: 'Name must be at least 2 characters long' });
    }

    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    if (!isValidPassword(password)) {
        return res.status(400).json({ 
            error: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character' 
        });
    }

    try {
        // Check if email already exists
        const [existingUsers] = await db.query('SELECT * FROM Users WHERE email = ?', [email]);
        if (existingUsers.length > 0) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        const hashedPassword = bcrypt.hashSync(password, 10);
        const [result] = await db.query('INSERT INTO Users (name, email, password) VALUES (?, ?, ?)', 
                      [name, email, hashedPassword]);
        
        // Generate token for new user
        const newUser = { id: result.insertId, name, email };
        const token = generateToken(newUser);
        
        res.status(201).json({ 
            message: 'User registered successfully',
            token,
            user: newUser
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    // Basic validation
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    try {
        const [users] = await db.query('SELECT * FROM Users WHERE email = ?', [email]);
        const user = users[0];

        if (!user || !bcrypt.compareSync(password, user.password)) {
            // Generic error message for security
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Generate JWT token
        const token = generateToken(user);
        
        res.json({ 
            message: 'Login successful',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
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
      
      // Instead of returning JSON, redirect to frontend with token in URL
      res.redirect(`http://localhost:8080/?token=${token}&userId=${req.user.user_id}&name=${encodeURIComponent(req.user.name)}&email=${encodeURIComponent(req.user.email)}`);
    } catch (err) {
      res.redirect('http://localhost:8080/login?error=Authentication+failed');
    }
  }
);

module.exports = router;