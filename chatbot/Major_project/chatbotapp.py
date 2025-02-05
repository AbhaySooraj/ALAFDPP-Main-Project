from flask import Flask, request, render_template
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
import numpy as np
from difflib import get_close_matches
import re
from nltk.stem import WordNetLemmatizer

app = Flask(__name__)

# Load data
file_path = "Airport_details.xlsx"
df = pd.read_excel(file_path)
df['Description'] = df['Description'].fillna(df['Type'])

# Build TF-IDF Model
vectorizer = TfidfVectorizer(stop_words='english')
tfidf_matrix = vectorizer.fit_transform(df['Description'])

lemmatizer = WordNetLemmatizer()

def filter_results_by_multiple_fields(query):
    """Filters results based on multiple criteria in the query."""
    query = query.lower().strip()
    query_parts = query.split()

    # Convert plural words to singular (spas -> spa, lounges -> lounge)
    query_parts = [lemmatizer.lemmatize(word) for word in query_parts]
    
    filtered_df = df.copy()

    # Ensure exact match for Type while keeping flexible matching for Location/Description
    exact_match_type = df[df['Type'].str.lower().isin(query_parts)]  # Strict match for Type
    
    # Only return results that match **all** query words together
    filtered_df = filtered_df[
        filtered_df.apply(lambda row: all(
            any(re.search(r'\b' + re.escape(part) + r'\b', str(row[col]).lower()) for col in ['Type', 'Location', 'Description'])
            for part in query_parts
        ), axis=1)
    ]
    
    # Prioritize exact Type matches if found
    if not exact_match_type.empty:
        return exact_match_type

    return filtered_df

def get_recommendations(query, top_n=5):
    query = query.lower()
    filtered_df = filter_results_by_multiple_fields(query)
    
    if not filtered_df.empty:
        return filtered_df[['Airport', 'Type', 'Name', 'Location', 'Description']].to_html(index=False)
    
    # Check for close matches in Name, Type, and Description
    all_text = df['Name'].dropna().tolist() + df['Type'].dropna().tolist() + df['Description'].dropna().tolist()
    close_matches = get_close_matches(query, all_text, n=top_n, cutoff=0.5)
    if close_matches:
        partial_match = df[df.apply(lambda row: any(match in str(row[col]) for match in close_matches for col in ['Name', 'Type', 'Description']), axis=1)]
        return partial_match[['Airport', 'Type', 'Name', 'Location', 'Description']].to_html(index=False)
    
    # Use TF-IDF similarity
    query_vec = vectorizer.transform([query])
    similarities = cosine_similarity(query_vec, tfidf_matrix).flatten()
    top_indices = np.argsort(similarities)[::-1][:top_n]
    top_results = df.iloc[top_indices]

    if any(similarities[top_indices] > 0):
        return top_results[['Airport', 'Type', 'Name', 'Location', 'Description']].to_html(index=False)
    else:
        return "<p>I'm sorry, I can't help you with that.</p>"

@app.route("/", methods=["GET", "POST"])
def index():
    if request.method == "POST":
        user_query = request.form.get("query")
        result = get_recommendations(user_query)
        return render_template("index.html", query=user_query, result=result)
    return render_template("index.html", query="", result="")

if __name__ == "__main__":
    app.run(debug=True)
