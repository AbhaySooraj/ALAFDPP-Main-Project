from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import pandas as pd
import os
import logging
from datetime import datetime, timedelta
from fuzzywuzzy import fuzz, process
import requests  # Add this import for making API requests

app = Flask(__name__)
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
            "car rental": DATA.parse("Bangalore car rental"),  # Use our specially handled DataFrame
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
            USER_STATE[user_id] = {"last_active": datetime.now()}

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

def handle_transport(airport, message):
    try:
        city_data = SHEETS[airport]["transport"]
        message = message.lower()  # Convert message to lowercase for case-insensitive matching
        
        # Special handling for "train"
        if "train" in message:
            key = next((k for k in city_data.keys() if "train" in k.lower()), None)
            if key:
                if not city_data[key].empty:
                    # Extract unique options for dropdowns, splitting by commas
                    train_data = city_data[key]
                    locations = pd.concat([
                        train_data["Departure"],
                        train_data["Arrival"],
                        train_data["Halt"]
                    ]).dropna().str.split(",").explode().str.strip().str.title().unique().tolist()
                    
                    # Remove "no stops" and sort the list
                    unique_locations = [loc for loc in locations if loc.lower() != "no stops"]
                    unique_locations.sort()
                    
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

        def match_row(row):
            return any(
                fuzz.partial_ratio(message, str(row[col]).lower()) > 70 or message in str(row[col]).lower()
                for col in ["Type", "Name"] if col in row
            )

        filtered_rows = df[df.apply(match_row, axis=1)]
        if not filtered_rows.empty:
            excluded_columns = ["description", "airport"]
            filtered_rows = filtered_rows.drop(columns=[col for col in excluded_columns if col in filtered_rows.columns], errors="ignore")
            # Exclude fields with missing data
            filtered_data = [
                {key: value for key, value in row.items() if pd.notna(value)}
                for row in filtered_rows.to_dict(orient="records")
            ]
            return jsonify({"response": filtered_data, "type": "list"})

        if "Type" in df.columns:
            facility_types = df["Type"].dropna().unique().tolist()
        else:
            facility_types = df.iloc[:, 0].dropna().unique().tolist()
        facility_types = [f for f in facility_types if isinstance(f, str) and f.strip()]
        return jsonify({
            "response": f"No facilities found matching '{message}' at {airport} Airport. Try one of these categories:",
            "buttons": facility_types[:5],
            "type": "text"
        })
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

@app.route("/")
def home():
    return send_from_directory(os.path.dirname(__file__), 'template.html')

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)