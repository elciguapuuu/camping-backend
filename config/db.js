require('dotenv').config();
const mysql = require('mysql2/promise');

// Create connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Initialize database schema if needed
async function initializeDatabase() {
  try {
    const connection = await pool.getConnection();
    // Database initialization code (if needed)
    connection.release();
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Initialize database on server start
initializeDatabase();

module.exports = pool;

