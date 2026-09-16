# ROOT Fit — web-based curve fitting backed by CERN ROOT

A free, account-less redesign of the Clayton State `chi2` fitting tool
(<https://sos.clayton.edu/physics/chi2/>). Paste data, type a function, get
parameters with uncertainties, χ²/NDF, a p-value and a proper plot — all
computed by ROOT's fitter (Minuit), drawn in the browser by JSROOT.

```
backend/    Python + Flask + PyROOT, runs in a Docker container (rootproject/root)
frontend/   one static page: index.html, app.js, style.css (no build step)
examples/   sample saved documents (JSON) you can load into the page
tests/      reference datasets with independently known results
root-run    helper: run any command inside the ROOT container
```

Nothing is stored on the server. The backend has one job (`POST /fit`), the
page keeps your work in a JSON file you download ("Save") and re-open ("Load").

## Run the backend

You need Docker. From the repo root:

```sh
docker build --platform linux/amd64 -t rootfit-backend backend
docker run --rm -p 8000:8000 rootfit-backend
```

The first build downloads the ROOT image (a few GB) — later builds are fast.
Check it is alive:

```sh
curl -s http://localhost:8000/health
```

## Open the frontend

Open `frontend/index.html` in a browser (double-click works), or serve the
folder with any static server, e.g. `cd frontend && python3 -m http.server 8080`
and visit <http://localhost:8080>. The "Backend URL" setting on the page
defaults to `http://localhost:8000`; change it if the backend runs elsewhere.

## Talk to the backend directly

```sh
curl -s -X POST http://localhost:8000/fit -H "Content-Type: application/json" -d '{
  "x": [1,2,3,4,5,6,7,8],
  "y": [2.3,4.1,6.2,7.9,10.3,11.8,14.1,16.2],
  "ey": [0.2,0.2,0.3,0.3,0.3,0.4,0.4,0.4],
  "formula": "[0]*x+[1]",
  "param_names": ["slope","intercept"],
  "initial_guesses": [1, 0],
  "title": "test", "x_title": "x", "y_title": "y"
}'
```

Response fields: `params[]` (name, value, error), `chi2`, `ndf`, `chi2_ndf`,
`prob`, `status` / `status_message` / `converged`, `covariance`, and the ROOT
objects for JSROOT: `canvas_json`, `graph_json`, `func_json`.
Errors: `{"error": "..."}` with HTTP 400 (your input) or 500 (server).

## Self-test inside the ROOT container

```sh
./root-run python3 backend/fit_test.py
```

fits `tests/linear_reference.json` and checks ROOT against the closed-form
weighted least-squares answer.

## Fit functions

Anything ROOT's `TFormula` understands, restricted by `backend/formula_check.py`
to: numbers, `x`, parameters `[0]`, `[1]`, ... (or `[name]`), `+ - * / ^ %`,
parentheses, comparisons and `? :`, the functions `exp log log10 sqrt pow abs
sin cos tan asin acos atan sinh cosh tanh`, an allow-list of `TMath::` functions,
and ROOT's named functions `gaus gausn expo landau landaun polN chebyshevN
crystalball breitwigner`.

Reference: [TF1](https://root.cern/doc/master/classTF1.html),
[TFormula](https://root.cern/doc/master/classTFormula.html),
[TMath](https://root.cern/doc/master/namespaceTMath.html).
