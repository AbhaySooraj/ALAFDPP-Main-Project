from flask import Flask, request, render_template
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
import numpy as np
from difflib import get_close_matches

app = Flask(__name__)

# Load data
file_path = "Airport_details.xlsx"
df = pd.read_excel(file_path)
df['Description'] = df['Description'].fillna(df['Type'])

# Build TF-IDF Model
vectorizer = TfidfVectorizer(stop_words='english')
tfidf_matrix = vectorizer.fit_transform(df['Description'])

def get_recommendations(query, top_n=5):
    # Check if query directly matches Name or Type
    direct_match = df[df['Name'].str.contains(query, case=False, na=False) | df['Type'].str.contains(query, case=False, na=False)]
    if not direct_match.empty:
        return direct_match[['Airport', 'Type', 'Name', 'Location', 'Description']].to_html(index=False)

    # Check for partial matches using fuzzy matching
    all_names = df['Name'].dropna().tolist()
    close_matches = get_close_matches(query, all_names, n=top_n, cutoff=0.6)
    if close_matches:
        partial_match = df[df['Name'].isin(close_matches)]
        return partial_match[['Airport', 'Type', 'Name', 'Location', 'Description']].to_html(index=False)

    # Use TF-IDF similarity on Description
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
