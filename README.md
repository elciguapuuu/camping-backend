# Seeker

## 🏕 Project Overview
Seeker is a camping spot rental platform built with Node.js and Express. This project contains the backend portion of the stack. 

## Authentication
### Traditional Auth
- **Register**: `POST /auth/register`
- **Login**: `POST /auth/login`

### Google OAuth
- **Login**: `GET /auth/google`
- **Callback**: `GET /auth/google/callback`

## User Management
- **Get All**: `GET /users`
- **Get One**: `GET /users/:id`
- **Update**: `PUT /users/:id`
- **Delete**: `DELETE /users/delete`

## Locations
- **Get All**: `GET /locations`
- **Create**: `POST /locations`
- **Search/Filter**: `GET /locations/search`
- **Owner's Locations**: `GET /locations/owner/:userId`
- **Update**: `PUT /locations/:id`
- **Delete**: `DELETE /locations/:id`

## Bookings
- **Get All**: `GET /bookings`
- **Get One**: `GET /bookings/:id`
- **Create**: `POST /bookings`
- **User's Bookings**: `GET /bookings/user/:userId`

## Reviews
- **Create**: `POST /reviews`
- **Get Location Reviews**: `GET /reviews/:location_id`

## Image Management
- **Upload**: `POST /upload`
- **Delete**: `DELETE /:id`

## Reference Data
- **Amenities**: `GET /amenities`
- **Campsite Types**: `GET /campsitetypes`

## Getting Started

### Prerequisites
- Node.js
- MySQL
- npm

### Installation
```bash
git clone <repository-url>
cd camping-backend
npm install
```

### Environment Setup
Create a `.env` file:
```env
DB_HOST=localhost
DB_USER=your_username
DB_PASSWORD=your_password
DB_NAME=airbnb_campers
DB_PORT=your_port

GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_CALLBACK_URL=http://localhost:3001/auth/google/callback
SESSION_SECRET=your_session_secret
```

### Running the Server
```bash
npm start
```
Server runs on `http://localhost:3001`

## Technologies Used
- Node.js
- Express
- MySQL
- Passport.js
- Google OAuth2.0
- Multer (image upload)
- JWT (authentication)

## License
MIT License
