from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import pandas as pd
import os
import logging
from datetime import datetime, timedelta, time
from fuzzywuzzy import fuzz, process
import requests
import json
import traceback  # Add this import at the top of the file
from sklearn.feature_extraction.text import TfidfVectorizer  # Add this import

# Custom JSON encoder to handle datetime.time objects
class CustomJSONEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, time):
            return obj.strftime('%H:%M:%S')
        return super().default(obj)

app = Flask(__name__)
app.json_encoder = CustomJSONEncoder  # Use our custom encoder
CORS(app)

# Configure logging
logging.basicConfig(level=logging.DEBUG)

# Load Excel file once
DATA_FILE = "Airport details.xlsx"
DATA = pd.ExcelFile(DATA_FILE)

# Now define SHEETS with the specially handled DataFrame
SHEETS = {
    "Bangalore": {
        "facilities": DATA.parse("Bangalore airport facilities"),
        "transport": {
            "bus": DATA.parse("Bangalore bus"),
            "car rental": DATA.parse("Bangalore car rental"),
            "taxis": DATA.parse("Bangalore taxis"),
            "train": DATA.parse("Bangalore Train"),
            "services": DATA.parse("Bangalore Transport service")
        },
        "visa": DATA.parse("Visa on Arrival Bangalore")
    },
    "Dubai": {
        "facilities": DATA.parse("Dubai Airport facilities"),
        "transport": {
            "metro": DATA.parse("Dubai metro"),
            "car rental": DATA.parse("Dubai car rental"),
            "services": DATA.parse("Dubai Transport services")
        },
        "visa": DATA.parse("Visa on Arrival Dubai"),
        "GCC": DATA.parse("GCC")
    }
}

USER_STATE = {}
SESSION_TIMEOUT = timedelta(hours=1)  # Define session timeout duration

# Cache for storing the list of valid countries
VALID_COUNTRIES_CACHE = []

# Utility function to clean up old sessions
def cleanup_sessions():
    now = datetime.now()
    expired_users = [user_id for user_id, state in USER_STATE.items() if state.get("last_active", now) < now - SESSION_TIMEOUT]
    for user_id in expired_users:
        del USER_STATE[user_id]
        logging.debug(f"Cleaned up session for user: {user_id}")

def fetch_valid_countries():
    global VALID_COUNTRIES_CACHE
    if not VALID_COUNTRIES_CACHE:
        try:
            # Fetch the list of countries from the REST Countries API
            response = requests.get("https://restcountries.com/v3.1/all")
            response.raise_for_status()  # Raise an error for HTTP issues
            countries = response.json()
            # Extract country names and store them in the cache
            VALID_COUNTRIES_CACHE = [country["name"]["common"] for country in countries if "name" in country and "common" in country["name"]]
            logging.debug(f"Fetched {len(VALID_COUNTRIES_CACHE)} countries from the API.")
        except Exception as e:
            logging.error(f"Failed to fetch countries from API: {str(e)}")
            VALID_COUNTRIES_CACHE = []  # Fallback to an empty list
    return VALID_COUNTRIES_CACHE

@app.route("/query", methods=["POST"])
def query():
    try:
        logging.debug("Received a request at /query endpoint")
        cleanup_sessions()  # Clean up old sessions
        data = request.get_json()
        user_id = data.get("user_id", "default")
        message = data.get("message", "").lower()

        if user_id not in USER_STATE:
            USER_STATE[user_id] = {"last_active": datetime.now(), "previous_replies": []}

        state = USER_STATE[user_id]
        state["last_active"] = datetime.now()  # Update last active time

        # Handle "bye" to end the session
        if "bye" in message:
            if user_id in USER_STATE:
                del USER_STATE[user_id]
                logging.debug(f"Ended session for user: {user_id}")
            return jsonify({"response": "Goodbye! Have a great day!", "type": "text"})

        # Handle "thanks" or "thank you"
        if "thanks" in message or "thank you" in message:
            return jsonify({"response": "You're welcome! Would you like any more assistance?", "type": "text"})

        # Handle "no" after an error or assistance prompt
        if "no" in message:
            if user_id in USER_STATE:
                del USER_STATE[user_id]
                logging.debug(f"Ended session for user: {user_id}")
            return jsonify({"response": "Goodbye! Have a great day!", "type": "text"})

        # Airport selection
        if "bangalore" in message:
            state["airport"] = "Bangalore"
            return jsonify({"response": "You selected Bangalore Airport. Choose an option:", "buttons": ["Transport", "Facilities", "Visa"]})
        elif "dubai" in message:
            state["airport"] = "Dubai"
            return jsonify({"response": "You selected Dubai Airport. Choose an option:", "buttons": ["Transport", "Facilities", "Visa"]})

        # Ensure an airport is selected before proceeding
        if "airport" not in state:
            return jsonify({"response": "Please select an airport first:", "buttons": ["Bangalore", "Dubai"]})

        # Category selection
        if "transport" in message:
            state["query"] = "transport"
            transport_options = list(SHEETS[state["airport"]]["transport"].keys())
            return jsonify({
                "response": f"What transportation option are you looking for at {state['airport']} Airport?", 
                "buttons": transport_options
            })
        elif "facilities" in message:
            state["query"] = "facilities"
            return jsonify({"response": "What facilities are you looking for? (e.g., lounge, spa, shops, restaurants)"})
        elif "visa" in message:
            state["query"] = "visa"
            return jsonify({"response": "Please enter your country name."})

        # Process queries based on state
        if "airport" in state and "query" in state:
            airport = state["airport"]
            query_type = state["query"]

            if query_type == "transport":
                return handle_transport(airport, message)
            elif query_type == "facilities":
                return handle_facilities(airport, message)
            elif query_type == "visa":
                return handle_visa(airport, message)

        # Default response if no state is matched
        response = jsonify({"response": "Which airport do you need assistance with? Bangalore or Dubai?", "buttons": ["Bangalore", "Dubai"]})
        logging.debug(f"Sending response: {response.get_json()}")
        return response

    except Exception as e:
        logging.error(f"Error: {str(e)}")
        return jsonify({
            "response": "An error occurred while processing your request. Would you like assistance with something else?",
            "buttons": ["Yes", "No"],
            "type": "text"
        })

# Handlers
# Helper function to convert time objects to strings
def convert_time(value):
    if isinstance(value, datetime.time):
        return value.strftime("%H:%M:%S")
    return value

def handle_transport(airport, message):
    try:
        city_data = SHEETS[airport]["transport"]
        message = message.lower()  # Convert message to lowercase for case-insensitive matching
        logging.debug(f"Processing transport query: '{message}' for {airport}")
        
        # Special handling for train - including when user has selected from/to locations
        if "train" in message or message.startswith("from:"):
            # Handle the case when user has selected locations from dropdown
            if message.startswith("from:"):
                try:
                    # Parse the from and to locations from the message
                    logging.debug(f"Parsing train route: {message}")
                    parts = message.split("to:")
                    from_location = parts[0].replace("from:", "").strip()
                    to_location = parts[1].strip()
                    logging.debug(f"Parsed locations - From: '{from_location}', To: '{to_location}'")
                    
                    # Find the train key
                    key = next((k for k in city_data.keys() if "train" in k.lower()), None)
                    if not key:
                        logging.debug("No train key found in city_data")
                        return jsonify({"response": "Train information is not available for this airport.", "type": "text"})
                    
                    train_data = city_data[key]
                    logging.debug(f"Train data columns: {train_data.columns.tolist()}")
                    
                    if "Departure" not in train_data.columns or "Arrival" not in train_data.columns:
                        # Handle different column names if needed
                        logging.debug("Column names don't match expected format.")
                        departure_col = next((col for col in train_data.columns if "depart" in col.lower()), train_data.columns[0])
                        arrival_col = next((col for col in train_data.columns if "arriv" in col.lower() or "dest" in col.lower()), train_data.columns[1])
                        logging.debug(f"Using columns: {departure_col} and {arrival_col}")
                        
                        # Filter results using the identified columns
                        filtered_data = train_data[
                            (train_data[departure_col].astype(str).str.contains(from_location, case=False, na=False)) &
                            (train_data[arrival_col].astype(str).str.contains(to_location, case=False, na=False))
                        ]
                    else:
                        # Use standard column names
                        filtered_data = train_data[
                            (train_data["Departure"].astype(str).str.contains(from_location, case=False, na=False)) &
                            (train_data["Arrival"].astype(str).str.contains(to_location, case=False, na=False))
                        ]
                    
                    logging.debug(f"Filtered data count: {len(filtered_data)}")
                    
                    if not filtered_data.empty:
                        results = [
                            {key: (value.strftime('%H:%M:%S') if isinstance(value, time) else value)  # Convert time objects to strings
                             for key, value in row.items() if pd.notna(value)}
                            for row in filtered_data.to_dict(orient="records")
                        ]
                        return jsonify({"response": results, "type": "list"})
                    else:
                        return jsonify({"response": f"No trains found from {from_location} to {to_location}.", "type": "text"})
                except Exception as e:
                    logging.error(f"Error processing train location selection: {str(e)}")
                    logging.error(f"Error traceback: {traceback.format_exc()}")
                    return jsonify({"response": f"Error processing your train route selection: {str(e)}", "type": "text"})
            
            # Original code for initial train selection
            key = next((k for k in city_data.keys() if "train" in k.lower()), None)
            if key:
                if not city_data[key].empty:
                    # Extract unique options for dropdowns, splitting by commas
                    train_data = city_data[key]
                    
                    # Check for expected columns
                    departure_col = "Departure" if "Departure" in train_data.columns else next((col for col in train_data.columns if "depart" in col.lower()), train_data.columns[0])
                    arrival_col = "Arrival" if "Arrival" in train_data.columns else next((col for col in train_data.columns if "arriv" in col.lower() or "dest" in col.lower()), train_data.columns[1])
                    halt_col = "Halt" if "Halt" in train_data.columns else next((col for col in train_data.columns if "halt" in col.lower() or "stop" in col.lower()), None)
                    
                    columns_to_use = [col for col in [departure_col, arrival_col, halt_col] if col is not None]
                    logging.debug(f"Using columns for location extraction: {columns_to_use}")
                    
                    # Extract locations from the identified columns
                    locations = pd.concat([train_data[col] for col in columns_to_use]).dropna()
                    if not locations.empty:
                        if locations.str.contains(',').any():
                            locations = locations.str.split(',').explode()
                        locations = locations.str.strip().str.title().unique().tolist()
                    else:
                        locations = []
                    
                    # Remove "no stops" and sort the list
                    unique_locations = [loc for loc in locations if loc.lower() not in ["no stops", "none", "na", "n/a"]]
                    unique_locations.sort()
                    
                    logging.debug(f"Found {len(unique_locations)} unique locations")
                    
                    return jsonify({
                        "response": "Please select a 'From' and 'To' location.",
                        "from_options": unique_locations,
                        "to_options": unique_locations,
                        "type": "dropdown"
                    })
                else:
                    return jsonify({"response": f"No data available for {key}.", "type": "text"})
            else:
                return jsonify({"response": "No transport data found for 'train'.", "type": "text"})
        
        # Rest of the original function for other transport options remains the same
        # First check for specific transport options using fuzzy matching
        best_match, score = process.extractOne(message, city_data.keys(), scorer=fuzz.partial_ratio)
        if score > 70:  # Use a threshold to determine a good match
            df = city_data[best_match]
            if not df.empty:
                # Exclude fields with missing data
                filtered_data = [
                    {key: value for key, value in row.items() if pd.notna(value)}
                    for row in df.to_dict(orient="records")
                ]
                return jsonify({"response": filtered_data, "type": "list"})
            else:
                return jsonify({"response": f"No {best_match} data found for {airport}.", "type": "text"})

        # If no exact match, search inside all sheets using fuzzy matching
        found_data = []
        for key, df in city_data.items():
            try:
                if df.apply(lambda row: row.astype(str).str.contains(message, case=False, na=False).any(), axis=1).any():
                    filtered_rows = df[df.apply(lambda row: row.astype(str).str.contains(message, case=False, na=False).any(), axis=1)]
                    found_data.extend([
                        {key: value for key, value in row.items() if pd.notna(value)}
                        for row in filtered_rows.to_dict(orient="records")
                    ])
            except Exception as e:
                logging.error(f"Error searching in {key}: {str(e)}")
        if found_data:
            return jsonify({"response": found_data, "type": "list"})

        # If still no results, suggest available options
        options = list(city_data.keys())
        return jsonify({
            "response": f"No matching transport data found for '{message}' at {airport} Airport. Available transport options:", 
            "buttons": options,
            "type": "text"
        })

    except Exception as e:
        logging.error(f"Error in handle_transport for query '{message}' at {airport} Airport: {str(e)}")
        return jsonify({"response": "An error occurred while processing your request. Please try again later.", "type": "text"})

def handle_facilities(airport, message):
    try:
        df = SHEETS[airport]["facilities"]
        message = message.lower()

        # Combine relevant columns into a single text field for TF-IDF
        if "Type" in df.columns and "Name" in df.columns and "Description" in df.columns:
            df["combined_text"] = df["Type"].fillna('') + " " + df["Name"].fillna('') + " " + df["Description"].fillna('')
        else:
            return jsonify({"response": "Facilities data is not properly formatted.", "type": "text"})

        # Initialize TF-IDF Vectorizer
        vectorizer = TfidfVectorizer(stop_words="english")
        tfidf_matrix = vectorizer.fit_transform(df["combined_text"].fillna(''))

        # Transform the user query
        query_vector = vectorizer.transform([message])

        # Compute cosine similarity between the query and facilities data
        from sklearn.metrics.pairwise import cosine_similarity
        similarity_scores = cosine_similarity(query_vector, tfidf_matrix).flatten()

        # Log similarity scores for debugging
        logging.debug(f"TF-IDF similarity scores: {similarity_scores}")

        # Get the top matches
        top_indices = similarity_scores.argsort()[-5:][::-1]  # Top 5 matches
        top_matches = df.iloc[top_indices]

        # Fallback: Filter by Type if TF-IDF results are not relevant
        if top_matches.empty or all(similarity_scores[top_indices] == 0):
            logging.debug("TF-IDF results are empty or irrelevant. Falling back to Type filtering.")
            if "lounge" in message:
                df = df[df["Type"].str.contains("lounge", case=False, na=False)]
            elif "restaurant" in message:
                df = df[df["Type"].str.contains("restaurant", case=False, na=False)]
            top_matches = df.head(5)  # Return the first 5 matches after filtering

        if not top_matches.empty:
            # Exclude fields with missing data and handle time objects
            filtered_data = []
            for row in top_matches.to_dict(orient="records"):
                cleaned_row = {}
                for key, value in row.items():
                    if pd.notna(value):
                        if isinstance(value, time):
                            cleaned_row[key] = value.strftime('%H:%M:%S')
                        else:
                            cleaned_row[key] = value
                filtered_data.append(cleaned_row)

            # Save the response to previous replies
            user_id = request.get_json().get("user_id", "default")
            if user_id in USER_STATE:
                USER_STATE[user_id]["previous_replies"].extend(filtered_data)

            # Include previous replies in the response
            return jsonify({
                "response": filtered_data,
                "type": "list",
                "previous_replies": USER_STATE[user_id]["previous_replies"]
            })

        return jsonify({"response": f"No facilities found matching '{message}' at {airport} Airport.", "type": "text"})

    except Exception as e:
        logging.error(f"Error in handle_facilities for query '{message}' at {airport} Airport: {str(e)}")
        return jsonify({"response": f"An error occurred while searching for facilities: {str(e)}", "type": "text"})

def handle_visa(airport, message):
    try:
        # Fetch the list of valid countries
        valid_countries = fetch_valid_countries()
        if not valid_countries:
            return jsonify({"response": "Unable to validate country names at the moment. Please try again later.", "type": "text"})

        # Validate if the input is a valid country
        country = message.strip().title()  # Normalize input
        if country not in valid_countries:
            return jsonify({"response": f"'{message}' is not recognized as a valid country. Please enter a valid country name.", "type": "text"})

        # Proceed with visa logic if the input is valid
        df = SHEETS[airport]["visa"]
        if not df[df.iloc[:, 1].str.contains(country, case=False, na=False)].empty:
            return jsonify({"response": "Hooray! Your passport is granted visa on arrival.", "type": "text"})
        elif airport == "Dubai":
            gcc_df = SHEETS[airport]["GCC"]
            if not gcc_df[gcc_df.iloc[:, 1].str.contains(country, case=False, na=False)].empty:
                return jsonify({"response": "As your country belongs to the GCC, you do not require a visa to enter.", "type": "text"})
        return jsonify({"response": "Unfortunately, your country does not have visa on arrival at this airport.", "type": "text"})
    except Exception as e:
        logging.error(f"Error in handle_visa for query '{message}' at {airport} Airport: {str(e)}")
        return jsonify({"response": f"An error occurred while checking visa information: {str(e)}", "type": "text"})

# FLIGHT DELAY PREDICTION ROUTES
@app.route("/amadeus/token", methods=["POST"])
def get_amadeus_token():
    try:
        data = request.get_json()
        client_id = data.get("client_id")
        client_secret = data.get("client_secret")
        api_endpoint = data.get("api_endpoint")
        
        if not all([client_id, client_secret, api_endpoint]):
            return jsonify({"error": "Missing credentials"}), 400
            
        response = requests.post(
            f"{api_endpoint}/v1/security/oauth2/token",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret
            }
        )
        
        if not response.ok:
            return jsonify({"error": f"Amadeus API error: {response.status_code}"}), response.status_code
            
        return jsonify(response.json())
    except Exception as e:
        logging.error(f"Error getting Amadeus token: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route("/amadeus/airport-search", methods=["GET"])
def search_airport():
    try:
        query = request.args.get("query")
        token = request.headers.get("Authorization")
        api_endpoint = request.args.get("api_endpoint")
        
        if not all([query, token, api_endpoint]):
            return jsonify({"error": "Missing parameters"}), 400
            
        response = requests.get(
            f"{api_endpoint}/v1/reference-data/locations?subType=AIRPORT&keyword={query}",
            headers={"Authorization": token}
        )
        
        if not response.ok:
            return jsonify({"error": f"Amadeus API error: {response.status_code}"}), response.status_code
            
        return jsonify(response.json())
    except Exception as e:
        logging.error(f"Error searching airports: {str(e)}")
        return jsonify({"error": str(e)}), 500

# Serve static files and pages
@app.route("/")
def home():
    return send_from_directory(os.path.dirname(__file__), 'home.html')

@app.route("/home.html")
def home_page():
    return send_from_directory(os.path.dirname(__file__), 'home.html')

@app.route("/about.html")
def about_page():
    return send_from_directory(os.path.dirname(__file__), 'about.html')

@app.route("/script.js")
def serve_script():
    return send_from_directory(os.path.dirname(__file__), 'script.js')

@app.route("/config.js")
def serve_config():
    return send_from_directory(os.path.dirname(__file__), 'config.js')

@app.route("/results.html")
def results_page():
    return send_from_directory(os.path.dirname(__file__), 'results.html')

@app.route("/results.js")
def serve_results_js():
    return send_from_directory(os.path.dirname(__file__), 'results.js')

@app.route("/styles.css")
def serve_styles():
    return send_from_directory(os.path.dirname(__file__), 'styles.css')
    
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)