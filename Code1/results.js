// Access API keys from environment variables
const AMADEUS_CLIENT_ID = config.AMADEUS_CLIENT_ID;
const AMADEUS_CLIENT_SECRET = config.AMADEUS_CLIENT_SECRET;
const AMADEUS_API_ENDPOINT = 'https://test.api.amadeus.com';
const OPENWEATHER_API_KEY = config.OPENWEATHER_API_KEY;
const OPENWEATHER_API_ENDPOINT = 'https://api.openweathermap.org/data/2.5';

// Rate limiter class to handle API rate limits
class RateLimiter {
    constructor(requestsPerSecond = 1) {
        this.queue = [];
        this.processing = false;
        this.lastRequestTime = 0;
        this.minInterval = 1000 / requestsPerSecond; // minimum time between requests in ms
    }

    async addToQueue(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.processing || this.queue.length === 0) return;

        this.processing = true;

        const now = Date.now();
        const timeToWait = Math.max(0, this.lastRequestTime + this.minInterval - now);

        await new Promise(resolve => setTimeout(resolve, timeToWait));

        const { fn, resolve, reject } = this.queue.shift();
        this.lastRequestTime = Date.now();

        try {
            const result = await fn();
            resolve(result);
        } catch (error) {
            reject(error);
        }

        this.processing = false;
        this.processQueue();
    }
}


// Create a global rate limiter instance (1 request per second)
const rateLimiter = new RateLimiter(1);

// Cache to store airport coordinates and weather data
const airportCoordinatesCache = {};
const weatherDataCache = {};

// Function to get Amadeus API token
async function getAmadeusToken() {
    try {
        const response = await fetch(`${AMADEUS_API_ENDPOINT}/v1/security/oauth2/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: AMADEUS_CLIENT_ID,
                client_secret: AMADEUS_CLIENT_SECRET
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data.access_token;
    } catch (error) {
        console.error('Error getting Amadeus token:', error);
        throw error;
    }
}

// New function to get airport coordinates
async function getAirportCoordinates(iataCode) {
    // Check cache first
    if (airportCoordinatesCache[iataCode]) {
        return airportCoordinatesCache[iataCode];
    }

    try {
        const token = await getAmadeusToken();
        const response = await fetch(
            `${AMADEUS_API_ENDPOINT}/v1/reference-data/locations?subType=AIRPORT&keyword=${iataCode}`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        if (data.data && data.data.length > 0) {
            const airport = data.data.find(item => item.iataCode === iataCode);
            if (airport && airport.geoCode) {
                const coordinates = {
                    lat: airport.geoCode.latitude,
                    lon: airport.geoCode.longitude,
                    name: airport.name,
                    city: airport.address?.cityName || ''
                };
                // Save to cache
                airportCoordinatesCache[iataCode] = coordinates;
                return coordinates;
            }
        }
        throw new Error(`Could not find coordinates for airport ${iataCode}`);
    } catch (error) {
        console.error(`Error fetching airport coordinates for ${iataCode}:`, error);
        return null;
    }
}

// New function to get weather data for an airport
async function getAirportWeather(iataCode) {
    try {
        // First get the coordinates of the airport
        const coordinates = await getAirportCoordinates(iataCode);
        if (!coordinates) {
            return { error: `Could not get coordinates for airport ${iataCode}` };
        }

        // Check cache using coordinates as key
        const cacheKey = `${coordinates.lat},${coordinates.lon}`;
        const now = Date.now();
        if (weatherDataCache[cacheKey] && (now - weatherDataCache[cacheKey].timestamp) < 30 * 60 * 1000) {
            // Return cached data if less than 30 minutes old
            return weatherDataCache[cacheKey].data;
        }

        // Fetch weather data from OpenWeatherMap
        const response = await fetch(
            `${OPENWEATHER_API_ENDPOINT}/weather?lat=${coordinates.lat}&lon=${coordinates.lon}&units=metric&appid=${OPENWEATHER_API_KEY}`
        );

        if (!response.ok) {
            throw new Error(`Weather API error! status: ${response.status}`);
        }

        const weatherData = await response.json();
        
        // Format the weather data
        const formattedWeather = {
            location: coordinates.name || `${iataCode} Airport`,
            city: coordinates.city,
            temperature: Math.round(weatherData.main.temp),
            feels_like: Math.round(weatherData.main.feels_like),
            description: weatherData.weather[0].description,
            icon: weatherData.weather[0].icon,
            humidity: weatherData.main.humidity,
            wind_speed: weatherData.wind.speed,
            pressure: weatherData.main.pressure,
            visibility: weatherData.visibility / 1000, // Convert to km
            timestamp: new Date(weatherData.dt * 1000).toLocaleString(),
            sunrise: new Date(weatherData.sys.sunrise * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
            sunset: new Date(weatherData.sys.sunset * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
        };

        // Save to cache
        weatherDataCache[cacheKey] = {
            data: formattedWeather,
            timestamp: now
        };

        return formattedWeather;
    } catch (error) {
        console.error(`Error fetching weather for airport ${iataCode}:`, error);
        return { error: `Could not get weather data: ${error.message}` };
    }
}

// Function to search for flights
async function searchFlights(origin, destination, date) {
    try {
        const token = await getAmadeusToken();
        const response = await fetch(
            `${AMADEUS_API_ENDPOINT}/v2/shopping/flight-offers?` +
            `originLocationCode=${origin}&` +
            `destinationLocationCode=${destination}&` +
            `departureDate=${date}&` +
            `adults=1&` +
            `nonStop=false&` +
            `max=20`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data.data || [];
    } catch (error) {
        console.error('Error fetching flights:', error);
        return [];
    }
}

// Function to get flight delay prediction
async function getFlightDelayPrediction(originLocationCode, destinationLocationCode, departureDateTime, carrierCode, flightNumber) {
    return rateLimiter.addToQueue(async () => {
        try {
            const token = await getAmadeusToken();

            const departureDateObj = new Date(departureDateTime);
            const departureDate = departureDateObj.toISOString().split('T')[0];
            const hours = String(departureDateObj.getHours()).padStart(2, '0');
            const minutes = String(departureDateObj.getMinutes()).padStart(2, '0');
            const departureTime = `${hours}:${minutes}:00`;

            const arrivalDateObj = new Date(departureDateObj.getTime() + (3 * 60 * 60 * 1000)); // Assuming 3-hour flight
            const arrivalDate = arrivalDateObj.toISOString().split('T')[0];
            const arrivalHours = String(arrivalDateObj.getHours()).padStart(2, '0');
            const arrivalMinutes = String(arrivalDateObj.getMinutes()).padStart(2, '0');
            const arrivalTime = `${arrivalHours}:${arrivalMinutes}:00`;

            const params = new URLSearchParams({
                originLocationCode: originLocationCode.toUpperCase(),
                destinationLocationCode: destinationLocationCode.toUpperCase(),
                departureDate,
                departureTime,
                arrivalDate,
                arrivalTime,
                aircraftCode: '320', // Ensure this matches the actual aircraft
                carrierCode: carrierCode.toUpperCase(),
                flightNumber: flightNumber.toString(),
                duration: 'PT3H'
            });

            const response = await fetch(
                `${AMADEUS_API_ENDPOINT}/v1/travel/predictions/flight-delay?${params.toString()}`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/json'
                    }
                }
            );

            if (!response.ok) {
                const errorData = await response.json();
                console.error("API Error Response:", errorData);

                // Handle specific error for "Data not seen at training time"
                if (errorData.errors?.[0]?.detail?.includes("Data not seen at training time")) {
                    return { predictionUnavailable: true, error: "No historical data available for this flight." };
                }

                throw new Error(`API Error: ${errorData.errors?.[0]?.detail || 'Unknown error'}`);
            }

            const data = await response.json();
            return data.data[0];
        } catch (error) {
            console.error('Error fetching delay prediction:', error);
            return { predictionUnavailable: true, error: error.message };
        }
    });
}

// Function to format duration
function formatDuration(duration) {
    return duration.replace('PT', '').toLowerCase();
}

// Function to convert currency to INR
const EUR_TO_INR = 90.50; // Example rate
const USD_TO_INR = 83.20; // Example rate

function convertToINR(amount, fromCurrency) {
    switch (fromCurrency) {
        case 'EUR':
            return amount * EUR_TO_INR;
        case 'USD':
            return amount * USD_TO_INR;
        case 'INR':
            return amount;
        default:
            console.warn(`Currency conversion not supported for ${fromCurrency}`);
            return amount;
    }
}

// Function to format price
function formatPrice(price, currency) {
    const priceInINR = convertToINR(parseFloat(price), currency);
    return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0
    }).format(priceInINR);
}

function getPredictionBadgeColor(probability) {
    if (probability < 0.15) {
        return 'bg-green-500';  // On time
    } else if (probability >= 0.15 && probability < 0.20) {
        return 'bg-green-500';  // 0-30 min delay
    } else if (probability >= 0.20 && probability < 0.25) {
        return 'bg-yellow-500'; // 30-60 min delay
    } else if (probability >= 0.25 && probability < 0.30) {
        return 'bg-red-500';    // 60-120 min delay
    } else {
        return 'bg-red-500';    // >120 min delay
    }
}

function getDelayCategory(probability) {
    if (probability < 0.15) {
        return 'On Time (< 30 min)';
    } else if (probability >= 0.15 && probability < 0.20) {
        return '0-30 min delay';
    } else if (probability >= 0.20 && probability < 0.25) {
        return '30-60 min delay';
    } else if (probability >= 0.25 && probability < 0.30) {
        return '60-120 min delay';
    } else {
        return '> 120 min delay';
    }
}

function isConnectionAtRisk(segments, delayPredictions) {
    for (let i = 0; i < segments.length - 1; i++) {
        const currentSegment = segments[i];
        const nextSegment = segments[i + 1];
        const currentDelay = delayPredictions[i];
        
        // Calculate layover duration in minutes
        const layoverDuration = (new Date(nextSegment.departure.at) - new Date(currentSegment.arrival.at)) / (1000 * 60);
        
        // Get predicted delay in minutes based on delay category
        let predictedDelay = 0;
        const probability = parseFloat(currentDelay?.probability || 0);
        
        if (probability >= 0.15 && probability < 0.20) predictedDelay = 30;
        else if (probability >= 0.20 && probability < 0.25) predictedDelay = 60;
        else if (probability >= 0.25 && probability < 0.30) predictedDelay = 120;
        else if (probability >= 0.30) predictedDelay = 180;
        
        // Connection is at risk if predicted delay exceeds layover time
        if (predictedDelay >= layoverDuration) {
            return true;
        }
    }
    return false;
}

// Helper function to get weather icon HTML
function getWeatherIconHTML(iconCode) {
    return `<img src="https://openweathermap.org/img/wn/${iconCode}@2x.png" alt="Weather icon" class="weather-icon">`;
}

async function createFlightCard(flight) {
    if (!flight.itineraries || !flight.itineraries[0].segments) {
        console.error("Invalid flight data:", flight);
        return "";
    }

    const itinerary = flight.itineraries[0];
    const segments = itinerary.segments;
    const priceInINR = formatPrice(flight.price.total, flight.price.currency);

    // Array to store delay predictions for all segments
    const delayPredictions = [];
    let routeDisplay = '';
    let isRisky = false;

    // Get the destination airport (final arrival airport)
    const finalDestination = segments[segments.length - 1].arrival.iataCode;
    
    // Fetch weather data for the destination airport
    let weatherData;
    try {
        weatherData = await getAirportWeather(finalDestination);
    } catch (error) {
        console.error(`Error fetching weather for ${finalDestination}:`, error);
        weatherData = { error: "Weather data unavailable" };
    }

    // Create weather section HTML
    let weatherHTML = '';
    if (weatherData && !weatherData.error) {
        weatherHTML = `
            <div class="weather-info">
                <h4>Weather at ${weatherData.location}</h4>
                <div class="weather-details">
                    <div class="weather-main">
                        ${getWeatherIconHTML(weatherData.icon)}
                        <div class="temperature">
                            <span class="temp-value">${weatherData.temperature}°C</span>
                            <span class="feels-like">Feels like: ${weatherData.feels_like}°C</span>
                        </div>
                    </div>
                    <div class="weather-description">
                        <p>${weatherData.description}</p>
                        <div class="weather-metrics">
                            <span>Humidity: ${weatherData.humidity}%</span>
                            <span>Wind: ${weatherData.wind_speed} m/s</span>
                            <span>Visibility: ${weatherData.visibility} km</span>
                        </div>
                    </div>
                </div>
            </div>`;
    } else {
        weatherHTML = `
            <div class="weather-info weather-error">
                <h4>Weather at ${finalDestination}</h4>
                <p>Weather information currently unavailable</p>
            </div>`;
    }

    // Process each segment
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        
        // Get delay prediction for this segment
        let delayPrediction;
        try {
            delayPrediction = await getFlightDelayPrediction(
                segment.departure.iataCode,
                segment.arrival.iataCode,
                segment.departure.at,
                segment.carrierCode,
                segment.number
            );
            delayPredictions.push(delayPrediction);
        } catch (error) {
            console.error('Error getting delay prediction:', error);
            delayPredictions.push({ predictionUnavailable: true, error: error.message });
        }

        // Create segment display
        let segmentDelayPrediction = '';
        if (delayPrediction?.predictionUnavailable) {
            segmentDelayPrediction = `
                <div class="delay-badge bg-gray-500 text-white px-3 py-1 rounded-full text-sm">
                    ${delayPrediction.error || "Prediction Unavailable"}
                </div>`;
        } else if (delayPrediction?.probability) {
            const probability = parseFloat(delayPrediction.probability);
            const badgeColor = getPredictionBadgeColor(probability);
            const delayCategory = getDelayCategory(probability);
            
            segmentDelayPrediction = `
                <div class="delay-badge ${badgeColor} text-white px-3 py-1 rounded-full text-sm">
                    ${delayCategory} (${(probability * 100).toFixed(1)}%)
                </div>`;
        }

        routeDisplay += `
            <div class="flight-segment">
                <div class="airline">
                    <div class="airline-code">${segment.carrierCode}</div>
                    <span>${segment.carrierCode} ${segment.number}</span>
                </div>
                <div class="flight-times">
                    <div class="departure">
                        <time>${segment.departure.at.slice(11, 16)}</time>
                        <span>${segment.departure.iataCode}</span>
                    </div>
                    <div class="flight-duration">
                        <span>${formatDuration(segment.duration)}</span>
                        <div class="duration-line"></div>
                    </div>
                    <div class="arrival">
                        <time>${segment.arrival.at.slice(11, 16)}</time>
                        <span>${segment.arrival.iataCode}</span>
                    </div>
                </div>
                <div class="delay-prediction">
                    ${segmentDelayPrediction}
                </div>
            </div>`;

        // Add layover information if there's a next segment
        if (i < segments.length - 1) {
            const layoverDuration = calculateLayoverDuration(
                new Date(segment.arrival.at),
                new Date(segments[i + 1].departure.at)
            );
            routeDisplay += `
                <div class="layover-info">
                    <div class="layover-duration">
                        ${layoverDuration} layover in ${segment.arrival.iataCode}
                    </div>
                </div>`;
        }
    }

    // Check if any connection is at risk
    isRisky = isConnectionAtRisk(segments, delayPredictions);

    // Create the flight card with weather information
    return `
        <div class="flight-card">
            <div class="route-summary">
                <div class="route-info">
                    ${segments[0].departure.iataCode} → ${segments[segments.length - 1].arrival.iataCode}
                    <span class="total-duration">Total duration: ${formatDuration(itinerary.duration)}</span>
                </div>
                ${isRisky ? '<div class="not-recommended">Not Recommended</div>' : ''}
            </div>
            <div class="flight-segments">
                ${routeDisplay}
            </div>
            ${weatherHTML}
            <div class="price-container">
                <span class="price">${priceInINR}</span>
                <button class="select-flight-btn">Select</button>
            </div>
        </div>`;
}

// Helper function to calculate layover duration
function calculateLayoverDuration(arrivalTime, departureTime) {
    const diff = departureTime - arrivalTime;
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
}

// Function to display flights
async function displayFlights(flights) {
    const container = document.getElementById('flights-container');
    if (flights.length === 0) {
        container.innerHTML = '<div class="no-flights">No flights found for this route and date.</div>';
        return;
    }

    container.innerHTML = '<div class="loading">Loading flight information...</div>';

    // Process flights in smaller batches
    const batchSize = 3;
    const flightCards = [];

    for (let i = 0; i < flights.length; i += batchSize) {
        const batch = flights.slice(i, i + batchSize);
        const batchCards = await Promise.all(batch.map(flight => createFlightCard(flight)));
        flightCards.push(...batchCards);

        // Update the display after each batch
        container.innerHTML = flightCards.join('') +
            (i + batchSize < flights.length ? '<div class="loading">Loading more flights...</div>' : '');
    }

    container.innerHTML = flightCards.join('');
}

// Get search parameters from URL
const urlParams = new URLSearchParams(window.location.search);
const origin = urlParams.get('origin');
const destination = urlParams.get('destination');
const date = urlParams.get('date');

// Update page with search details
document.getElementById('route-summary').textContent = `${origin} → ${destination}`;
document.getElementById('date-summary').textContent = new Date(date).toLocaleDateString();

// Initial flight search
searchFlights(origin, destination, date).then(flights => {
    displayFlights(flights);
});

// Sort by price
document.getElementById('sort-price').addEventListener('click', async () => {
    const flights = await searchFlights(origin, destination, date);
    flights.sort((a, b) => parseFloat(a.price.total) - parseFloat(b.price.total));
    displayFlights(flights);
});

// Sort by duration
document.getElementById('sort-duration').addEventListener('click', async () => {
    const flights = await searchFlights(origin, destination, date);
    flights.sort((a, b) => {
        const durationA = convertDurationToMinutes(a.itineraries[0].duration);
        const durationB = convertDurationToMinutes(b.itineraries[0].duration);
        return durationA - durationB;
    });
    displayFlights(flights);
});

// Back button handler
document.getElementById('back-btn').addEventListener('click', () => {
    window.location.href = 'home.html';
});

// Helper function to convert duration to minutes
function convertDurationToMinutes(durationString) {
    const duration = durationString.replace('PT', '');
    let minutes = 0;

    const hoursMatch = duration.match(/(\d+)H/);
    if (hoursMatch) {
        minutes += parseInt(hoursMatch[1]) * 60;
    }

    const minutesMatch = duration.match(/(\d+)M/);
    if (minutesMatch) {
        minutes += parseInt(minutesMatch[1]);
    }

    return minutes;
}