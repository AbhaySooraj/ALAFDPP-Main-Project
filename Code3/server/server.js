require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const port = 3000;

// Your Aviation Edge API key
const API_KEY = 'b077ff-cd2aa9';
const BASE_URL = 'https://aviation-edge.com/v2/public';

app.use(cors());
app.use(express.json());

// Helper function to log detailed error information
function logError(endpoint, error) {
    console.error(`Error in ${endpoint}:`);
    console.error('Status:', error.response?.status);
    console.error('Status Text:', error.response?.statusText);
    console.error('Error Data:', error.response?.data);
    console.error('Error Message:', error.message);
    if (error.config) {
        console.error('Request URL:', error.config.url);
        console.error('Request Method:', error.config.method);
        console.error('Request Params:', error.config.params);
    }
}

// Endpoint to fetch airports
app.get('/api/airports', async (req, res) => {
    try {
        const { searchTerm } = req.query;
        console.log('Fetching airports for:', searchTerm);
        
        const url = `${BASE_URL}/airportDatabase`;
        console.log('Request URL:', url);
        
        const response = await axios.get(url, {
            params: {
                key: API_KEY,
                codeIataAirport: searchTerm,
                limit: 5
            }
        });
        
        console.log('Airports API Response:', response.status);
        res.json(response.data);
    } catch (error) {
        logError('/api/airports', error);
        res.status(500).json({ 
            error: 'Failed to fetch airports',
            details: error.response?.data || error.message
        });
    }
});

// Endpoint to search flights
app.get('/api/flights', async (req, res) => {
    try {
        const { departure, arrival, date } = req.query;
        console.log('Searching flights:', { departure, arrival, date });
        
        const url = `${BASE_URL}/schedules`;
        console.log('Request URL:', url);
        
        const response = await axios.get(url, {
            params: {
                key: API_KEY,
                dep_iata: departure,
                arr_iata: arrival,
                date: date
            }
        });
        
        console.log('Flights API Response:', response.status);
        if (!Array.isArray(response.data)) {
            console.warn('Unexpected response format:', response.data);
            res.status(500).json({ 
                error: 'Invalid response format from Aviation Edge API',
                details: response.data
            });
            return;
        }
        
        res.json(response.data);
    } catch (error) {
        logError('/api/flights', error);
        res.status(500).json({ 
            error: 'Failed to fetch flights',
            details: error.response?.data || error.message
        });
    }
});

// Endpoint to get flight status
app.get('/api/flight-status', async (req, res) => {
    try {
        const { flightIata, date } = req.query;
        console.log('Fetching flight status:', { flightIata, date });
        
        const url = `${BASE_URL}/flightStatus`;
        console.log('Request URL:', url);
        
        const response = await axios.get(url, {
            params: {
                key: API_KEY,
                flightIata: flightIata,
                date: date
            }
        });
        
        console.log('Flight Status API Response:', response.status);
        res.json(response.data);
    } catch (error) {
        logError('/api/flight-status', error);
        res.status(500).json({ 
            error: 'Failed to fetch flight status',
            details: error.response?.data || error.message
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Global error handler:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        details: err.message
    });
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log('API Key:', API_KEY ? 'Set' : 'Not set');
});