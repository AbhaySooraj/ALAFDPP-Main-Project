const API_KEY = 'b077ff-cd2aa9';
const BASE_URL = 'https://aviation-edge.com/v2/public';
const CORS_PROXY = 'https://corsproxy.io/?'; // Using a different CORS proxy

// Helper function to create proxied URL
function getProxiedUrl(url) {
    return `${CORS_PROXY}${encodeURIComponent(url)}`;
}

// Debug function to log API responses
function logApiResponse(endpoint, response, error = null) {
    console.group(`API Call to ${endpoint}`);
    console.log('Status:', response?.status);
    console.log('Response:', response);
    if (error) console.error('Error:', error);
    console.groupEnd();
}

// Fetch airports for autocomplete
async function fetchAirports(searchTerm) {
    const endpoint = '/api/airports';
    try {
        console.log(`Fetching airports for search term: ${searchTerm}`);
        
        const response = await fetch(
            `http://localhost:3000${endpoint}?searchTerm=${searchTerm}`
        );
        
        logApiResponse(endpoint, response);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log('Airports data:', data);
        return data;
    } catch (error) {
        logApiResponse(endpoint, null, error);
        console.error('Error fetching airports:', error);
        return [];
    }
}


function setupAutocomplete(inputId, listId) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    let debounceTimer;

    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        const searchTerm = input.value.trim().toUpperCase();

        if (searchTerm.length < 2) {
            list.style.display = 'none';
            return;
        }

        debounceTimer = setTimeout(async () => {
            const airports = await fetchAirports(searchTerm);
            
            list.innerHTML = '';
            
            if (airports && airports.length > 0) {
                list.style.display = 'block';
                airports.forEach(airport => {
                    const div = document.createElement('div');
                    div.className = 'autocomplete-item';
                    div.textContent = `${airport.codeIataAirport} - ${airport.nameAirport} (${airport.nameCountry})`;
                    div.addEventListener('click', () => {
                        input.value = airport.codeIataAirport;
                        list.style.display = 'none';
                    });
                    list.appendChild(div);
                });
            } else {
                list.style.display = 'none';
            }
        }, 300);
    });

    document.addEventListener('click', (e) => {
        if (!input.contains(e.target)) {
            list.style.display = 'none';
        }
    });
}

async function searchFlights(departure, arrival, date) {
    const loading = document.getElementById('loading');
    const resultsDiv = document.getElementById('results');
    
    try {
        loading.style.display = 'block';
        resultsDiv.innerHTML = '';

        const formattedDate = new Date(date).toISOString().split('T')[0];
        
        console.log(`Searching flights from ${departure} to ${arrival} on ${formattedDate}`);

        const endpoint = '/api/flights';
        const response = await fetch(
            `http://localhost:3000${endpoint}?departure=${departure}&arrival=${arrival}&date=${formattedDate}`
        );
        
        logApiResponse(endpoint, response);

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.details || data.error || `HTTP error! status: ${response.status}`);
        }

        if (!Array.isArray(data)) {
            throw new Error('Invalid response format from API');
        }

        if (data.length === 0) {
            resultsDiv.innerHTML = `
                <div class="error-message">
                    No flights found for the selected route and date.
                </div>
            `;
            return;
        }

        // Get real-time status for each flight
        const flightPromises = data.map(async flight => {
            try {
                const statusEndpoint = '/api/flight-status';
                const statusResponse = await fetch(
                    `http://localhost:3000${statusEndpoint}?flightIata=${flight.flight.iataNumber}&date=${formattedDate}`
                );
                
                logApiResponse(statusEndpoint, statusResponse);
                
                const statusData = await statusResponse.json();
                if (!statusResponse.ok) {
                    console.error('Flight status error:', statusData);
                    return flight;
                }
                
                return { ...flight, status: statusData[0] };
            } catch (error) {
                console.error('Error fetching flight status:', error);
                return flight;
            }
        });

        const flightsWithStatus = await Promise.all(flightPromises);
        displayFlights(flightsWithStatus);

    } catch (error) {
        console.error('Error in searchFlights:', error);
        resultsDiv.innerHTML = `
            <div class="error-message">
                <h3>Error fetching flight data</h3>
                <p>${error.message}</p>
                <p>Please check the following:</p>
                <ul>
                    <li>Verify that the airport codes are correct</li>
                    <li>Ensure the selected date is valid</li>
                    <li>Try again in a few moments</li>
                </ul>
            </div>
        `;
    } finally {
        loading.style.display = 'none';
    }
}
function displayFlights(flights) {
    const resultsDiv = document.getElementById('results');
    resultsDiv.innerHTML = '';

    if (!flights || flights.length === 0) {
        resultsDiv.innerHTML = `
            <div class="error-message">
                No flights found for the selected route and date.
            </div>
        `;
        return;
    }

    flights.forEach(flight => {
        const departureTime = new Date(flight.departure.scheduledTime).toLocaleString();
        const arrivalTime = new Date(flight.arrival.scheduledTime).toLocaleString();
        
        const flightCard = document.createElement('div');
        flightCard.className = 'flight-card';
        
        flightCard.innerHTML = `
            <h3>Flight ${flight.flight.iataNumber}</h3>
            <div class="flight-info">
                <div class="flight-info-item">
                    <strong>Departure</strong>
                    <p>${flight.departure.iataCode}</p>
                    <p>${departureTime}</p>
                    <p>Terminal ${flight.departure.terminal || 'N/A'}</p>
                </div>
                
                <div class="flight-info-item">
                    <strong>Arrival</strong>
                    <p>${flight.arrival.iataCode}</p>
                    <p>${arrivalTime}</p>
                    <p>Terminal ${flight.arrival.terminal || 'N/A'}</p>
                </div>

                <div class="flight-info-item">
                    <strong>Airline</strong>
                    <p>${flight.airline?.name || 'N/A'}</p>
                    <p>Aircraft: ${flight.aircraft?.modelText || 'N/A'}</p>
                </div>

                ${flight.status ? `
                    <div class="flight-info-item">
                        <strong>Status</strong>
                        <p>${flight.status.status || 'N/A'}</p>
                        ${flight.status.delay ? `<p>Delay: ${flight.status.delay} minutes</p>` : ''}
                    </div>
                ` : ''}
            </div>
        `;
        
        resultsDiv.appendChild(flightCard);
    });
}

setupAutocomplete('departure', 'departureList');
setupAutocomplete('arrival', 'arrivalList');

// Set minimum date to today
const dateInput = document.getElementById('date');
const today = new Date().toISOString().split('T')[0];
dateInput.min = today;

// Form submission handler
document.getElementById('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const departure = document.getElementById('departure').value.trim().toUpperCase();
    const arrival = document.getElementById('arrival').value.trim().toUpperCase();
    const date = document.getElementById('date').value;
    
    if (!departure || !arrival || !date) {
        alert('Please fill in all fields');
        return;
    }
    
    console.log('Form submitted with values:', { departure, arrival, date });
    searchFlights(departure, arrival, date);
});

// Log API key status on load
console.log('API Key status:', API_KEY ? 'Set' : 'Not set');