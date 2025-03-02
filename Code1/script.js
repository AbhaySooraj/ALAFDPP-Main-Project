// Store API credentials (in a secure way in production)
const AMADEUS_CLIENT_ID = config.AMADEUS_CLIENT_ID;
const AMADEUS_CLIENT_SECRET = config.AMADEUS_CLIENT_SECRET;
const AMADEUS_API_ENDPOINT = 'https://test.api.amadeus.com';  

// Function to get access token
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

// Function to fetch airport suggestions with proper authentication
async function fetchAirportSuggestions(query) {
    if (!query || query.length < 1) return [];
    
    try {
        const token = await getAmadeusToken();
        
        const response = await fetch(
            `${AMADEUS_API_ENDPOINT}/v1/reference-data/locations?subType=AIRPORT&keyword=${encodeURIComponent(query)}`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data.data.map(airport => ({
            name: airport.name,
            iata: airport.iataCode
        }));
    } catch (error) {
        console.error('Error fetching airport suggestions:', error);
        return [];
    }
}

// Function to display suggestions
function displaySuggestions(suggestions, listElement, inputElement) {
    listElement.innerHTML = "";
    suggestions.forEach((airport) => {
        const li = document.createElement("li");
        li.textContent = `${airport.name} (${airport.iata})`;
        li.addEventListener("click", () => {
            inputElement.value = airport.iata;
            listElement.innerHTML = "";
        });
        listElement.appendChild(li);
    });
}

// Event listener for autocomplete
function setupAutocomplete(inputId, suggestionsId) {
    const inputElement = document.getElementById(inputId);
    const suggestionsElement = document.getElementById(suggestionsId);

    let debounceTimer;

    inputElement.addEventListener("input", async () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            const query = inputElement.value.trim();
            const suggestions = await fetchAirportSuggestions(query);
            displaySuggestions(suggestions, suggestionsElement, inputElement);
        }, 300); // Debounce for 300ms
    });

    // Close suggestions when clicking outside
    document.addEventListener("click", (event) => {
        if (!suggestionsElement.contains(event.target) && event.target !== inputElement) {
            suggestionsElement.innerHTML = "";
        }
    });
}

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Initialize autocomplete for both fields
    setupAutocomplete("departure-airport", "departure-suggestions");
    setupAutocomplete("destination-airport", "destination-suggestions");

    // Handle form submission
    document.getElementById("search-btn").addEventListener("click", function () {
        const departureAirport = document.getElementById("departure-airport").value;
        const destinationAirport = document.getElementById("destination-airport").value;
        const travelDate = document.getElementById("travel-date").value;

        if (departureAirport && destinationAirport && travelDate) {
            // Directly redirect to results page
            window.location.href = `results.html?origin=${departureAirport}&destination=${destinationAirport}&date=${travelDate}`;
        } else {
            alert("Please fill all the fields before searching.");
        }
    });
});