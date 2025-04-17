const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-camping-app-secret-key';

/**
 * Middleware to authenticate JWT tokens
 * Usage: Add this middleware to any routes that require authentication
 */
const authenticateToken = (req, res, next) => {
  // Get token from Authorization header
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN format
  
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    // Verify and decode the token
    const decoded = jwt.verify(token, JWT_SECRET);

     // Add user data to request object for use in route handlers
     req.user = decoded;
     next();
   } catch (err) {
     return res.status(403).json({ error: 'Invalid or expired token' });
   }
 };
 
 module.exports = { authenticateToken };
  