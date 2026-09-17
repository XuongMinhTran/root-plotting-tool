# ROOT Fit — web-based curve fitting backed by CERN ROOT

A free, account-less redesign of the Clayton State `chi2` fitting tool
(<https://sos.clayton.edu/physics/chi2/>). Paste data, type a function, get
parameters with uncertainties, χ²/NDF, a p-value and a proper plot — all
computed by ROOT's fitter (Minuit), drawn in the browser by JSROOT.

```
backend/    Python + Flask + PyROOT, runs in a Docker container (rootproject/root)
frontend/   landing page, Classic and Modern interfaces (no build step)
examples/   sample saved documents (JSON) you can load into the page
tests/      reference datasets with independently known results
root-run    helper: run any command inside the ROOT container
```

The form backend stores no analysis data: `POST /fit` returns a result, and
the page saves your work in a JSON file you download ("Save") and re-open
("Load").

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

Open `frontend/index.html` for the front page, then choose **Make a Plot** and **Classic** or **Modern**. Classic is the compact desktop-style layout. Modern is a worksheet: three numbered steps (data, function, labels and extras) in one column, with the plot and fit report in a panel beside them that stays in view, so changing a setting and fitting again never hides the result; below about 1100px the panel moves underneath. Both share every function in `app.js`. `modern.js` adds only Modern's own presentation — the clickable function shapes (mirrored from the `quick-pick` list app.js maintains, so they follow the analysis type), the one-line summary under each step, and the step highlight that follows the page. Modern's visual design follows root.cern: ROOT blue `#346295`, sand `#e9dcbe` hairlines, a pale blue-grey footer and a 4px radius. **What is ROOT?** opens a short explanation and a link to the official website.

You can also open `frontend/classic.html` or `frontend/modern.html` directly. For shared autosave when switching between Classic and Modern, serve the pages from the same address. Serve the
folder with any static server, e.g. `cd frontend && python3 -m http.server 8080`
and visit <http://localhost:8080>. The "Backend URL" setting on the page
defaults to `http://localhost:8000`; change it if the backend runs elsewhere.

### Using the page

Paste X and Y (and optionally the errors) one value per line, type a fit
function or pick one from "Examples…", give parameter names / starting values,
and press **Fit** (or Ctrl/Cmd+Enter). A single X or Y error value applies to every point on that axis; leave it blank for no errors, or enter one value per point. The exponential-decay choice in **Examples…** estimates starting values from the current data. The plot is the ROOT canvas drawn by
JSROOT; the report lists every parameter ± uncertainty, χ², NDF, χ²/NDF and
the p-value.

- **Save document** downloads a `.json` file with everything: inputs, the
  last fit result (including the ROOT canvas, so it redraws without a backend),
  title, notes and timestamps. `examples/` contains a few.
- **Load document** opens a saved file (file picker, drag-and-drop anywhere on
  the page, or paste the JSON text).
- **Dataset fit settings** are independent: each dataset retains its own function,
  parameter names, initial guesses and fit range. New XY tables start with a
  straight-line function and blank parameter and range fields. These fields can
  be edited in the main form or beneath each table in the table editor. Done
  applies table edits; Cancel discards them. Older documents migrate their shared
  settings to each existing dataset, and save/load preserves subsequent changes.
- **Optional plots** include residuals, pulls, data/fit ratio, percentage difference, and a residual histogram. Select any combination under **Labels & plot → Plot options** (Classic) or **Fit settings → Labels and plot options** (Modern), then fit again. All are off by default. **Advanced optional plot settings** lets you rename each selected plot, set axis labels and Y limits, panel height, point scope, grids, reference lines, uncertainty bars, and histogram bins. Settings are saved with the document; older single-panel selections migrate automatically. Ratio and percentage uncertainty bars hold the fitted model fixed and are not model confidence bands. Undefined points are omitted with an explanatory message.
- **Export PNG** renders the current plot to an image.
- The form is autosaved in your browser (localStorage) so a reload does not
  lose your work; nothing leaves your machine except the fit request.

### Histograms

Both interfaces have an **Analysis type → Histogram** selector in Data.
Choose individual measurements with a bin count and optional range, or
pre-binned counts with explicit bin edges. Custom, unequal-width edges are
supported for either input type. The final right edge is included; measurements
outside the edges are reported separately. Use **Plot histogram** without a
model, or choose a formula and fit in the normal Fit settings.

The graph includes a results box with counts, fitted parameters and uncertainties,
and the appropriate fit statistic. Without a fit it shows the distribution mean
and standard deviation (estimated from bin centers for pre-binned input). The
histogram example uses `gausn`: its `norm` parameter is the model’s full area,
while ordinary `gaus` uses a peak amplitude.

The first version accepts unweighted, nonnegative integer counts. It does not
accept normalized, background-subtracted or weighted bin contents. ROOT fits
the original counts with `TH1::Fit`; the function is a **count density**, and
`I` plus `WIDTH` integrates it over each bin. The display divides counts and
their uncertainties by bin width. Fit ranges select bins by their centers.

**Poisson likelihood** is the default, includes empty bins, and reports
Poisson deviance without an approximate χ² p-value. **χ²** uses √count
uncertainties and excludes empty bins. Optional diagnostics compare counts
with integrated predictions; pulls use √prediction for Poisson and √count
for χ². All optional panels remain off by default.

Save/load and autosave retain the analysis type, both input formats, binning,
method and results. CSV reports include a bin table with counts, density and
predicted counts. **Example: count histogram** is available in Classic's Fit
menu and Modern's More menu, and as `examples/04-count-histogram.json`.

The separate `POST /histogram` endpoint accepts a `histogram` object with
`source: "samples"`, `samples`, `bins`, optional `range` and `edges`, or
`source: "counts"`, `counts` and `edges`. Set `method` to `poisson` or `chi2`.
The outer object accepts the usual formula, parameter and plot settings;
`fit_model: false` creates a histogram without a fit. Limits are 100,000
measurements and 2–2,000 bins.

Run histogram checks with `node tests/histogram_frontend_test.cjs` and
`docker run --rm --platform linux/amd64 -v "$PWD":/work -w /work/backend rootfit-backend python3 -m unittest histogram_test`.

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

Run HTTP regression checks with `docker run --rm --platform linux/amd64 -v "$PWD":/work -w /work/backend rootfit-backend python3 app_test.py`, and frontend checks with `node tests/frontend_test.cjs`.

The self-test fits `tests/linear_reference.json` and checks ROOT against the closed-form
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
