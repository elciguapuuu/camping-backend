# Seeker - Backend

## 🏕 Project Overview
Seeker is a camping spot rental platform. This project contains the backend portion of the stack, built with Node.js, Express, and MySQL. It provides a RESTful API for managing users, locations, bookings, reviews, and payments.

## API Endpoints

### Authentication (`/auth`)
- **Register**: `POST /register` - Creates a new user account.
- **Login**: `POST /login` - Authenticates a user and returns a JWT.
- **Google OAuth Login**: `GET /google` - Initiates Google OAuth2 authentication.
- **Google OAuth Callback**: `GET /google/callback` - Handles the callback from Google after authentication.

### Users (`/users`)
- **Get All Users**: `GET /` (Admin access might be preferable)
- **Get User by ID**: `GET /:id` - Retrieves a specific user's public profile.
- **Update User Profile**: `PUT /:id` - Updates a user's own profile information.
- **Deactivate Account**: `DELETE /delete` - Marks the authenticated user's account as inactive (soft delete).
- **Upload Profile Picture**: `POST /profile-picture` - Uploads or updates the user's profile picture.

### Locations (`/locations`)
- **Get All Locations**: `GET /` - Retrieves all available locations.
- **Create New Location**: `POST /` - Adds a new camping location (requires authentication).
- **Search/Filter Locations**: `GET /search` - Searches locations based on criteria like name, price, amenities, availability.
- **Get Owner's Locations**: `GET /owner/:userId` - Retrieves locations owned by a specific user (requires authentication, user can only fetch their own).
- **Get Location by ID**: `GET /:id` - Retrieves details for a specific location.
- **Update Location**: `PUT /:id` - Updates an existing location (requires ownership).
- **Delete Location**: `DELETE /:id` - Deletes a location and its associated data (requires ownership).
- **Upload Location Images**: `POST /:location_id/images` - Adds images to a location (requires ownership).
- **Get Location Images**: `GET /:location_id/images` - Retrieves images for a location.
- **Manage Location Amenities**: `POST /:location_id/amenities`, `GET /:location_id/amenities`
- **Manage Location Campsite Types**: `POST /:location_id/campsitetype`, `GET /:location_id/campsitetype`
- **Add Location Unavailability**: `POST /:location_id/unavailability` - Marks a location as unavailable for a specified period (requires ownership).
- **Get Location Earnings**: `GET /:location_id/earnings/weekly` - Retrieves weekly earnings for a location (requires ownership).

### Bookings (`/bookings`)
- **Get All Bookings**: `GET /` (Admin access might be preferable)
- **Get Booking by ID**: `GET /:id` - Retrieves a specific booking (requires user ownership or location ownership).
- **Create New Booking**: `POST /` - Creates a new booking for a location (requires authentication).
- **Get User's Bookings**: `GET /user/:userId` - Retrieves all bookings made by a specific user (requires authentication, user can only fetch their own).
- **Get Location's Bookings**: `GET /location/:locationId` - Retrieves all bookings for a specific location (requires location ownership).
- **Cancel Booking**: `PATCH /:id/cancel` - Cancels a booking (user or owner, with refund logic via Stripe if applicable).
- **Get Booked Dates for Location**: `GET /location/:locationId/booked-dates` - Retrieves dates for which a location is already booked.

### Reviews (`/reviews`)
- **Create Review**: `POST /` - Adds a new review for a location (requires a completed booking by the user).
- **Get Location Reviews**: `GET /:location_id` - Retrieves all reviews for a specific location.
- **Update Review**: `PUT /:review_id` - Updates an existing review (requires review ownership).
- **Delete Review**: `DELETE /:review_id` - Deletes a review (requires review ownership or admin).
- **Get Average Rating**: `GET /:location_id/average` - Calculates and returns the average rating for a location.

### Payments (`/payments`)
- **Create Payment Intent**: `POST /create-payment-intent` - Creates a Stripe Payment Intent for a booking.

### Reference Data
- **Get All Amenities**: `GET /amenities` (via `amenities.js` router, or `locations/amenities`)
- **Get All Campsite Types**: `GET /campsitetypes` (via `campsitetypes.js` router, or `locations/campsitetypes`)

## Getting Started

### Prerequisites
- Node.js (v14.x or later recommended)
- MySQL Server (v5.7 or later recommended)
- npm (usually comes with Node.js)
- Git

### Installation
1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd camping-backend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```

### Database Setup
1. Ensure your MySQL server is running.
2. Create a database named `airbnb_campers` (or the name you specify in your `.env` file).
3. Import the schema from `airbnb_campers.sql` into your database. This file contains the table structures and initial seed data.
   ```bash
   # Example using mysql command line:
   mysql -u your_username -p airbnb_campers < airbnb_campers.sql
   ```

### Environment Setup
Create a `.env` file in the `camping-backend` root directory with the following variables. Replace placeholder values with your actual configuration.
```env
DB_HOST=localhost
DB_USER=your_mysql_username
DB_PASSWORD=your_mysql_password
DB_NAME=airbnb_campers
DB_PORT=3306 # Or your MySQL port

# JWT Configuration
JWT_SECRET=your_very_strong_jwt_secret # Replace with a long, random string
JWT_EXPIRES_IN=1d # Or your preferred expiration time (e.g., 1h, 7d)

# Google OAuth Credentials
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_CALLBACK_URL=http://localhost:3001/auth/google/callback # Ensure this matches your Google API Console configuration

# Cloudinary Credentials (for image uploads)
CLOUDINARY_CLOUD_NAME=your_cloudinary_cloud_name
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret

# Stripe Credentials (for payments)
STRIPE_PUBLISHABLE_KEY=pk_test_your_stripe_publishable_key # For client-side
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key # For server-side

# Server Configuration
PORT=3001
NODE_ENV=development # 'production' or 'development'

# Session Secret (if using sessions, though JWT is primary for API)
SESSION_SECRET=another_strong_secret_for_sessions
```

### Running the Server
```bash
npm nodemon app.js
```
By default, the server will run on `http://localhost:3001` (or the `PORT` specified in your `.env` file).

### Scheduled Tasks
There is a scheduled task for updating booking statuses (e.g., from 'confirmed' to 'completed' after the end date). 
- Script: `scheduled-tasks/updateBookingStatus.js`
- To run manually (or set up with a cron job/task scheduler):
  ```bash
  node scheduled-tasks/updateBookingStatus.js
  ```
- A sample Windows command file `run_update_task.cmd` is provided.

## Technologies Used
- **Node.js**: JavaScript runtime environment.
- **Express.js**: Web application framework for Node.js.
- **MySQL2**: MySQL client for Node.js.
- **Passport.js**: Authentication middleware for Node.js (used for Google OAuth).
- **jsonwebtoken (JWT)**: For creating and verifying JSON Web Tokens for API authentication.
- **bcryptjs**: For hashing passwords.
- **Multer**: Middleware for handling `multipart/form-data`, used for file uploads.
- **Cloudinary**: Cloud-based image and video management service.
- **Stripe**: Online payment processing.
- **Dotenv**: For loading environment variables from a `.env` file.
- **Nodemon**: Utility that monitors for changes and automatically restarts the server (for development).

## Usability Notes
- **Authentication**: Most routes require a valid JWT passed in the `Authorization` header as a Bearer token.
- **User Roles**: While not explicitly implemented as a granular role system, some routes have implicit ownership checks (e.g., a user can only edit their own locations or bookings).
- **Error Handling**: API responses use standard HTTP status codes. Errors typically return a JSON object with an `error` message and sometimes a `details` field.
- **Soft Deletes**: User accounts are soft-deleted (marked as inactive) to preserve data integrity for associated bookings, reviews, etc.
- **Image Handling**: Images are uploaded to Cloudinary, and their URLs/public IDs are stored in the database.

## License
MIT License
