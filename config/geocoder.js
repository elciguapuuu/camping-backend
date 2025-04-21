const NodeGeocoder = require('node-geocoder');

// Use OpenStreetMap (Nominatim) which is free
const options = {
  provider: 'openstreetmap',
  httpAdapter: 'https',
  formatter: null,
  language: 'en',
  // Add user agent to avoid rate limiting
  userAgent: 'Camping_App',
  // Increase timeout for complex addresses
  timeout: 10000
};

const geocoder = NodeGeocoder(options);

// Enhanced geocode function with retries and address formatting
async function enhancedGeocode(address, city, country) {
  try {
    console.log(`Attempting to geocode address: ${address}, ${city}, ${country}`);
    
    // Try different address formats, from most specific to least specific
    const addressFormats = [
      `${address}, ${city}, ${country}`,
      `${city}, ${country}`,
      `${address}, ${country}`,
      `${city}`
    ];
    
    // Try each format until we get results
    for (const addressFormat of addressFormats) {
      console.log(`Trying format: ${addressFormat}`);
      
      const results = await geocoder.geocode(addressFormat);
      
      if (results && results.length > 0) {
        console.log(`Success with format: ${addressFormat}`);
        return {
          success: true,
          format: addressFormat,
          results: results,
          latitude: results[0].latitude,
          longitude: results[0].longitude,
          formattedAddress: results[0].formattedAddress
        };
      }
    }
    
    // If we get here, all attempts failed
    return {
      success: false,
      error: "Could not geocode the provided address"
    };
  } catch (error) {
    console.error("Geocoding error:", error);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  geocoder,
  enhancedGeocode
};