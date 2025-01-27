document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('flightForm');
    const resultsDiv = document.getElementById('results');
    
    // Setup autocomplete for both inputs
    setupAutocomplete('departure');
    setupAutocomplete('destination');
    
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        // Show loading state
        resultsDiv.innerHTML = `
            <div class="bg-blue-100 border border-blue-400 text-blue-700 px-4 py-3 rounded">
                Loading flight data...
            </div>
        `;
        
        const departure = document.getElementById('departure').value;
        const destination = document.getElementById('destination').value;
        const date = document.getElementById('date').value;
        
        try {
            const response = await fetch('http://localhost:3000/api/flights', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ departure, destination, date })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            displayResults(data);
        } catch (error) {
            console.error('Error:', error);
            resultsDiv.innerHTML = `
                <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
                    Error fetching flight data. Please make sure the server is running and try again.
                </div>
            `;
        }
    });
});

function setupAutocomplete(inputId) {
    const input = document.getElementById(inputId);
    const wrapper = input.parentElement;
    
    // Create and append suggestions container
    const suggestionsContainer = document.createElement('div');
    suggestionsContainer.className = 'absolute z-10 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto hidden mt-1';
    wrapper.classList.add('relative');
    wrapper.appendChild(suggestionsContainer);
    
    let debounceTimeout;
    
    input.addEventListener('input', async (e) => {
        const query = e.target.value.trim();
        
        if (debounceTimeout) {
            clearTimeout(debounceTimeout);
        }
        
        if (!query) {
            suggestionsContainer.innerHTML = '';
            suggestionsContainer.classList.add('hidden');
            return;
        }
        
        // Show loading state
        suggestionsContainer.innerHTML = `
            <div class="px-4 py-2 text-gray-500">Searching airports...</div>
        `;
        suggestionsContainer.classList.remove('hidden');
        
        debounceTimeout = setTimeout(async () => {
            try {
                const response = await fetch(`http://localhost:3000/api/airports/search?query=${encodeURIComponent(query)}`);
                if (!response.ok) throw new Error('Network response was not ok');
                
                const airports = await response.json();
                
                if (!Array.isArray(airports) || airports.length === 0) {
                    suggestionsContainer.innerHTML = `
                        <div class="px-4 py-2 text-gray-500">No airports found</div>
                    `;
                    return;
                }
                
                suggestionsContainer.innerHTML = airports.map(airport => `
                    <div class="suggestion px-4 py-2 hover:bg-gray-100 cursor-pointer" 
                         data-iata="${airport.iata}">
                        <div class="font-medium">${airport.name}</div>
                        <div class="text-sm text-gray-600">
                            ${airport.city}
                            ${airport.timezone ? ` (${airport.timezone})` : ''}
                        </div>
                        <div class="text-xs text-gray-500">${airport.country}</div>
                    </div>
                `).join('');
                
                // Add click handlers to suggestions
                suggestionsContainer.querySelectorAll('.suggestion').forEach(suggestion => {
                    suggestion.addEventListener('click', () => {
                        input.value = suggestion.dataset.iata;
                        suggestionsContainer.classList.add('hidden');
                    });
                });
            } catch (error) {
                console.error('Error fetching airports:', error);
                suggestionsContainer.innerHTML = `
                    <div class="px-4 py-2 text-red-500">Error searching airports. Please try again.</div>
                `;
            }
        }, 300);
    });
    
    // Hide suggestions when clicking outside
    document.addEventListener('click', (e) => {
        if (!wrapper.contains(e.target)) {
            suggestionsContainer.classList.add('hidden');
        }
    });
    
    // Handle keyboard navigation
    input.addEventListener('keydown', (e) => {
        const suggestions = suggestionsContainer.querySelectorAll('.suggestion');
        const active = suggestionsContainer.querySelector('.bg-gray-100');
        
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            
            if (!suggestions.length) return;
            
            let nextActive;
            if (!active) {
                nextActive = e.key === 'ArrowDown' ? suggestions[0] : suggestions[suggestions.length - 1];
            } else {
                const currentIndex = Array.from(suggestions).indexOf(active);
                const nextIndex = e.key === 'ArrowDown' 
                    ? (currentIndex + 1) % suggestions.length
                    : (currentIndex - 1 + suggestions.length) % suggestions.length;
                nextActive = suggestions[nextIndex];
            }
            
            active?.classList.remove('bg-gray-100');
            nextActive.classList.add('bg-gray-100');
            nextActive.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' && active) {
            e.preventDefault();
            input.value = active.dataset.iata;
            suggestionsContainer.classList.add('hidden');
        } else if (e.key === 'Escape') {
            suggestionsContainer.classList.add('hidden');
        }
    });
}

function displayResults(flights) {
    const resultsDiv = document.getElementById('results');
    
    if (!flights.length) {
        resultsDiv.innerHTML = `
            <div class="bg-yellow-100 border border-yellow-400 text-yellow-700 px-4 py-3 rounded">
                No flights found for the selected criteria.
            </div>
        `;
        return;
    }
    
    const flightCards = flights.map(flight => `
        <div class="bg-white rounded-lg shadow-md p-6">
            <div class="flex justify-between items-center mb-4">
                <div>
                    <h3 class="text-lg font-bold">${flight.airline.name}</h3>
                    <p class="text-gray-600">Flight ${flight.flight.number}</p>
                </div>
                <div class="text-right">
                    <p class="font-bold">${formatTime(flight.departure.scheduledTime)} - ${formatTime(flight.arrival.scheduledTime)}</p>
                    <p class="text-gray-600">${formatDuration(flight.duration)}</p>
                </div>
            </div>
            <div class="flex justify-between text-sm">
                <div>
                    <p class="font-bold">${flight.departure.iataCode}</p>
                    <p class="text-gray-600">${flight.departure.airport}</p>
                </div>
                <div class="text-right">
                    <p class="font-bold">${flight.arrival.iataCode}</p>
                    <p class="text-gray-600">${flight.arrival.airport}</p>
                </div>
            </div>
        </div>
    `).join('');
    
    resultsDiv.innerHTML = flightCards;
}

function formatTime(timeString) {
    return new Date(timeString).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatDuration(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
}