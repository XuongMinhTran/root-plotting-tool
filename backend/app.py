"""
app.py — the web server. Two endpoints, no state, no storage.

    GET  /health   -> {"status": "ok", "root_version": "...", ...}
    POST /fit      -> runs one fit and returns the result as JSON

Request body for /fit (JSON):
    {
      "x": [1, 2, 3],            "y": [2.1, 3.9, 6.2],
      "ex": [],                  "ey": [0.2, 0.2, 0.3],      # optional, may be [] or null
      "formula": "[0]*x+[1]",                                 # TFormula string or "gaus", "pol2", ...
      "param_names": ["slope", "offset"],                     # optional, may be shorter
      "initial_guesses": [1, 0],                              # optional, may be shorter, null entries ok
      "title": "", "x_title": "", "y_title": "",              # optional
      "x_range": [xmin, xmax]                                 # optional fit range
    }

Errors always come back as {"error": "..."}: 400 when the request is at fault
(bad numbers, columns of different length, disallowed formula), 500 when ROOT
or the server failed.

Run directly:   python3 app.py        (listens on 0.0.0.0:8000)
In Docker:      see Dockerfile
"""

import threading
import traceback

from flask import Flask, jsonify, request

from formula_check import check_formula, allowed_summary
import fit  # imports ROOT (slow, ~1-2 s) once at start-up

import ROOT

APP_VERSION = "0.1.0"
MAX_POINTS = 100_000

app = Flask(__name__)

# ROOT is not thread-safe, and Flask serves requests on several threads.
# One fit at a time keeps Cling and Minuit happy; fits take milliseconds anyway.
root_lock = threading.Lock()


@app.after_request
def add_cors_headers(response):
    """Let the static frontend call us from any origin (file://, localhost, a
    GitHub Pages site, ...). There are no cookies or accounts, so a wide-open
    CORS policy gives away nothing."""
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


class BadRequest(ValueError):
    """Raised for anything that is the caller's fault -> HTTP 400."""


def number_list(payload, key, required):
    """Read a column of numbers from the request. Accepts numbers or numeric
    strings; [] / null are fine for optional columns."""
    raw = payload.get(key)
    if raw is None or raw == "":
        if required:
            raise BadRequest(f"Missing column '{key}'.")
        return []
    if not isinstance(raw, list):
        raise BadRequest(f"Column '{key}' must be a list of numbers.")
    if len(raw) > MAX_POINTS:
        raise BadRequest(f"Column '{key}' has more than {MAX_POINTS} points.")
    values = []
    for i, v in enumerate(raw):
        try:
            f = float(v)
        except (TypeError, ValueError):
            raise BadRequest(f"Column '{key}', entry {i + 1} ({v!r}) is not a number.")
        if f != f or f in (float("inf"), float("-inf")):
            raise BadRequest(f"Column '{key}', entry {i + 1} is not a finite number.")
        values.append(f)
    if required and not values:
        raise BadRequest(f"Column '{key}' is empty.")
    return values


def string_list(payload, key):
    raw = payload.get(key) or []
    if isinstance(raw, str):                      # allow "a, b, c" as well as a list
        raw = [s.strip() for s in raw.split(",")]
    if not isinstance(raw, list):
        raise BadRequest(f"'{key}' must be a list.")
    return [str(s).strip() for s in raw]


def guess_list(payload, key):
    raw = payload.get(key) or []
    if isinstance(raw, str):
        raw = [s.strip() for s in raw.split(",")]
    if not isinstance(raw, list):
        raise BadRequest(f"'{key}' must be a list.")
    out = []
    for i, v in enumerate(raw):
        if v is None or v == "":
            out.append(None)                      # "leave this one at ROOT's default"
            continue
        try:
            out.append(float(v))
        except (TypeError, ValueError):
            raise BadRequest(f"Initial guess {i + 1} ({v!r}) is not a number.")
    return out


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "service": "rootfit-backend",
        "version": APP_VERSION,
        "root_version": str(ROOT.gROOT.GetVersion()),
    })


@app.route("/allowed", methods=["GET"])
def allowed():
    """What the formula whitelist accepts — handy for the frontend help text."""
    return jsonify(allowed_summary())


@app.route("/fit", methods=["POST"])
def do_fit():
    try:
        payload = request.get_json(force=True, silent=True)
        if not isinstance(payload, dict):
            raise BadRequest("Request body must be a JSON object.")

        x = number_list(payload, "x", required=True)
        y = number_list(payload, "y", required=True)
        ex = number_list(payload, "ex", required=False)
        ey = number_list(payload, "ey", required=False)

        # Explain length mismatches precisely: this is the most common mistake.
        if len(x) != len(y):
            raise BadRequest(f"x has {len(x)} points but y has {len(y)}.")
        if ex and len(ex) != len(x):
            raise BadRequest(f"x errors: {len(ex)} values, but there are {len(x)} data points "
                             "(leave the column empty for no x errors).")
        if ey and len(ey) != len(x):
            raise BadRequest(f"y errors: {len(ey)} values, but there are {len(x)} data points "
                             "(leave the column empty for no y errors).")

        formula = str(payload.get("formula") or "").strip()
        ok, message = check_formula(formula)
        if not ok:
            raise BadRequest(f"Fit function rejected: {message}")

        par_names = string_list(payload, "param_names")
        par_guesses = guess_list(payload, "initial_guesses")

        x_range = payload.get("x_range")
        if x_range not in (None, "", []):
            try:
                x_range = (float(x_range[0]), float(x_range[1]))
            except (TypeError, ValueError, IndexError):
                raise BadRequest("x_range must be [xmin, xmax].")
        else:
            x_range = None

        with root_lock:
            result = fit.run_fit(
                x, y, ex, ey, formula,
                par_names=par_names, par_guesses=par_guesses, x_range=x_range,
                title=payload.get("title", ""),
                x_title=payload.get("x_title", ""),
                y_title=payload.get("y_title", ""),
                plot=payload.get("plot") if isinstance(payload.get("plot"), dict) else None,
            )
        return jsonify(result)

    except BadRequest as e:
        return jsonify({"error": str(e)}), 400
    except ValueError as e:                        # raised by fit.py for bad input / bad formula
        return jsonify({"error": str(e)}), 400
    except Exception as e:                         # anything else is our problem
        traceback.print_exc()
        return jsonify({"error": f"Server error during fit: {type(e).__name__}: {e}"}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=False)
