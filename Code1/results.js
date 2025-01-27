const AMADEUS_CLIENT_ID = 'IzxjSAopsbAdL9aQJlTMzrMRBKpf3xSq';
const AMADEUS_CLIENT_SECRET = '9TlGnbTogpsE657A';
const AMADEUS_API_ENDPOINT = 'https://test.api.amadeus.com';

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

// Function to get prediction badge color
function getPredictionBadgeColor(probability) {
    if (probability > 0.7) return 'bg-red-500';
    if (probability > 0.4) return 'bg-yellow-500';
    return 'bg-green-500';
}

// Function to get readable delay category
function getDelayCategory(delayType) {
    const categories = {
        'LESS_THAN_30_MINUTES': 'On Time (< 30 min)',
        'BETWEEN_30_AND_60_MINUTES': '30-60 min delay',
        'BETWEEN_60_AND_120_MINUTES': '1-2 hour delay',
        'GREATER_THAN_120_MINUTES': '> 2 hour delay'
    };
    return categories[delayType] || delayType;
}

// Function to create a flight card
async function createFlightCard(flight) {
    if (!flight.itineraries || !flight.itineraries[0].segments) {
        console.error("Invalid flight data:", flight);
        return "";
    }

    const itinerary = flight.itineraries[0];
    const segment = itinerary.segments[0];
    const priceInINR = formatPrice(flight.price.total, flight.price.currency);

    let delayPredictionHtml = '';
    try {
        const delayPrediction = await getFlightDelayPrediction(
            segment.departure.iataCode,
            segment.arrival.iataCode,
            segment.departure.at,
            segment.carrierCode,
            segment.number
        );

        console.log("Delay Prediction Response:", delayPrediction);

        if (delayPrediction?.predictionUnavailable) {
            delayPredictionHtml = `
                <div class="delay-prediction">
                    <div class="delay-badge bg-gray-500 text-white px-3 py-1 rounded-full text-sm">
                        ${delayPrediction.error || "Prediction Unavailable"}
                    </div>
                </div>
            `;
        } else if (delayPrediction?.result) {
            // Handle the single result and probability
            const probability = parseFloat(delayPrediction.probability);
            
            // Get appropriate color based on delay category
            let badgeColor;
            if (delayPrediction.result === 'LESS_THAN_30_MINUTES') {
                badgeColor = 'bg-green-500';
            } else if (delayPrediction.result === 'BETWEEN_30_AND_60_MINUTES') {
                badgeColor = 'bg-yellow-500';
            } else {
                badgeColor = 'bg-red-500';
            }

            delayPredictionHtml = `
                <div class="delay-prediction">
                    <div class="delay-badge ${badgeColor} text-white px-3 py-1 rounded-full text-sm">
                        ${getDelayCategory(delayPrediction.result)}
                        (${(probability * 100).toFixed(1)}%)
                    </div>
                </div>
            `;
        } else {
            delayPredictionHtml = `
                <div class="delay-prediction">
                    <div class="delay-badge bg-gray-500 text-white px-3 py-1 rounded-full text-sm">
                        Status Unknown
                    </div>
                </div>
            `;
        }
    } catch (error) {
        console.error('Error in flight card creation:', error);
        delayPredictionHtml = `
            <div class="delay-prediction">
                <div class="delay-badge bg-gray-500 text-white px-3 py-1 rounded-full text-sm">
                    Prediction Error
                </div>
            </div>
        `;
    }

    return `
        <div class="flight-card">
            <div class="flight-main-info">
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
                        <span>${formatDuration(itinerary.duration)}</span>
                        <div class="duration-line"></div>
                    </div>
                    <div class="arrival">
                        <time>${segment.arrival.at.slice(11, 16)}</time>
                        <span>${segment.arrival.iataCode}</span>
                    </div>
                </div>
                <div class="price">
                    <span>${priceInINR}</span>
                    ${delayPredictionHtml}
                </div>
            </div>
            <div class="flight-details">
                <button class="select-flight-btn">Select</button>
            </div>
        </div>
    `;
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