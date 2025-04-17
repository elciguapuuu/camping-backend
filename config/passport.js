const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const db = require('./db');
require('dotenv').config();

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL
}, async (accessToken, refreshToken, profile, done) => {
    try {
        console.log('Google profile:', profile); //logging

        // Check if user exists
        const [users] = await db.query('SELECT * FROM Users WHERE google_id = ?', [profile.id]);
        
        if (users.length > 0) {
            return done(null, users[0]);
        }

        // Create new user with only required fields
        const [result] = await db.query(
            'INSERT INTO Users (name, email, google_id, auth_type) VALUES (?, ?, ?, ?)',
            [
                profile.displayName,
                profile.emails[0].value,
                profile.id,
                'google'
            ]
        );

        const newUser = {
            user_id: result.insertId,
            name: profile.displayName,
            email: profile.emails[0].value,
            google_id: profile.id,
            auth_type: 'google'
        };

        return done(null, newUser);
    } catch (error) {
        console.error('Passport error:', error);
        return done(error, null);
    }
}));

passport.serializeUser((user, done) => {
    done(null, user.user_id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const [users] = await db.query('SELECT * FROM Users WHERE user_id = ?', [id]);
        done(null, users[0] || null);
    } catch (error) {
        done(error, null);
    }
});

module.exports = passport;