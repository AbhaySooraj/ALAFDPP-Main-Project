const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper function to fetch city details
async function getCityDetails(cityId) {
    try {
        const response = await axios.get('https://aviation-edge.com/v2/public/cityDatabase', {
            params: {
                key: process.env.AVIATION_EDGE_API_KEY,
                cityId: cityId
            }
        });
        return Array.isArray(response.data) ? response.data[0] : null;
    } catch (error) {
        console.error('Error fetching city details:', error);
        return null;
    }
}

app.get('/api/airports/search', async (req, res) => {
    const { query } = req.query;
    
    if (!query || query.length < 2) {
        return res.json([]);
    }
    
    try {
        // First get airports
        const airportResponse = await axios.get('https://aviation-edge.com/v2/public/airportDatabase', {
            params: {
                key: process.env.AVIATION_EDGE_API_KEY,
                searchBy: query.length === 3 ? 'codeIataAirport' : 'nameAirport',
                [query.length === 3 ? 'codeIataAirport' : 'nameAirport']: query
            }
        });
        
        // Filter airports first
        let airports = Array.isArray(airportResponse.data) ? airportResponse.data.filter(airport => {
            if (!airport) return false;
            
            const searchQuery = query.toLowerCase();
            const airportName = airport.nameAirport || '';
            const iataCode = airport.codeIataAirport || '';
            const cityName = airport.nameCity || '';
            
            return (
                airportName.toLowerCase().includes(searchQuery) ||
                iataCode.toLowerCase().includes(searchQuery) ||
                cityName.toLowerCase().includes(searchQuery)
            );
        }) : [];
        
        // Limit to top 10 before fetching city details to reduce API calls
        airports = airports.slice(0, 10);
        
        // Fetch city details for each airport
        const airportsWithCities = await Promise.all(
            airports.map(async (airport) => {
                let cityDetail = null;
                if (airport.cityId) {
                    cityDetail = await getCityDetails(airport.cityId);
                }
                
                return {
                    iata: airport.codeIataAirport || '',
                    name: airport.nameAirport ? `${airport.nameAirport} (${airport.codeIataAirport || 'N/A'})` : 'Unknown Airport',
                    city: cityDetail ? `${cityDetail.nameCity}, ${cityDetail.GMT || ''}` : (airport.nameCity || 'Unknown City'),
                    country: airport.nameCountry || 'Unknown Country',
                    timezone: cityDetail?.GMT || '',
                    latitude: airport.latitudeAirport || '',
                    longitude: airport.longitudeAirport || ''
                };
            })
        );
        
        // Filter out airports without IATA codes
        const finalAirports = airportsWithCities.filter(airport => airport.iata);
        
        res.json(finalAirports);
    } catch (error) {
        console.error('Airport search error:', error.response?.data || error);
        res.status(500).json({ error: 'Error searching airports' });
    }
});

app.post('/api/flights', async (req, res) => {
    const { departure, destination, date } = req.body;
    
    try {
        const response = await axios.get('https://aviation-edge.com/v2/public/timetable', {
            params: {
                key: process.env.AVIATION_EDGE_API_KEY,
                iataCode: departure,
                type: 'departure',
                arr_iataCode: destination,
            }
        });
        
        res.json(response.data);
    } catch (error) {
        console.error('API Error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Error fetching flight data' });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});