"""
app.py — Flask server for Class Timetable Scheduler
Usage:  python app.py
Requires: flask, pulp, pandas
Install: pip install flask pulp pandas
"""

from flask import Flask, jsonify, request, render_template
from datetime import datetime
from scheduler import run_solver, verify_timetable

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/solve", methods=["POST"])
def solve():
    data = request.get_json()
    if not data:
        return jsonify({"status": "error", "message": "No data received"}), 400
    try:
        result = run_solver(data)
        result["timestamp"] = datetime.now().isoformat()
        return jsonify(result)
    except Exception as e:
        import traceback
        return jsonify({"status": "error", "message": str(e),
                        "trace": traceback.format_exc()}), 500


@app.route("/api/verify", methods=["POST"])
def verify():
    payload = request.get_json()
    if not payload:
        return jsonify({"error": "No data received"}), 400
    try:
        result = verify_timetable(payload["config"], payload["timetable"])
        return jsonify(result)
    except Exception as e:
        import traceback
        return jsonify({"error": str(e), "trace": traceback.format_exc()}), 500


if __name__ == "__main__":
    print("Class Timetable Scheduler running at http://localhost:5000")
    app.run(debug=True, port=5000)
