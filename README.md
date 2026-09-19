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
start       one command: build if needed, run, open the browser
root-run    helper: run any command inside the ROOT container
```

The form backend stores no analysis data: `POST /fit` returns a result, and
the page saves your work in a JSON file you download ("Save") and re-open
("Load").

## Start it

You need Docker. Then, from the repo root:

```sh
./start
```

macOS and Linux both. It builds the image if it is missing, starts the server,
waits for it, and opens <http://localhost:8000>. Press Ctrl-C, or close the
window, to stop. The first build downloads the ROOT image (a few GB); later
starts take seconds.

Linux users: see **[LINUX.md](LINUX.md)** for installing Docker, the
applications-menu launcher, SELinux, ARM, rootless and WSL2 notes.

For one button instead of one command:

- **macOS** — double-click `Start ROOT-A-TRON 3000.command` in Finder.
- **Linux** — run `./start --install-desktop` once; "ROOT-A-TRON 3000" then
  appears in your applications menu.

```sh
./start                    # build if needed, run, open a browser
./start --rebuild          # force a fresh image build first
./start --no-open          # leave the browser alone
./start --install-desktop  # Linux applications-menu launcher
```

`start` rebuilds automatically when a file under `backend/` is newer than the
last build. On macOS it launches Docker Desktop for you if it is not running;
on Linux it tells you the `systemctl` command, and recognizes the "user is not
in the docker group" case. It relabels the bind mount under SELinux, falls back
from curl to wget to the container's own Python for the health check, and
prefers `xdg-open` over `/usr/bin/open` (which on Linux can be `openvt`).

Environment overrides:

| | |
|---|---|
| `ROOTFIT_DOCKER=podman` | use podman instead of docker |
| `ROOTFIT_PLATFORM=` | drop `--platform linux/amd64` and build natively |
| `ROOTFIT_PORT=9000` | listen somewhere other than 8000 |

The frontend is bind-mounted into the container rather than baked into the
image, so editing a page and reloading is enough — no rebuild, no second
server, and one origin for both the pages and the API.

### Running the pieces by hand

```sh
docker build --platform linux/amd64 -t rootfit-backend backend
docker run --rm -p 8000:8000 -v "$PWD/frontend:/app/frontend:ro" rootfit-backend
curl -s http://localhost:8000/health
```

Leaving out the `-v` gives you the API alone; the pages then still work from
`file://` or any static server, and fall back to `http://localhost:8000` for
the API. Set `FRONTEND_DIR` to serve the frontend from somewhere else.

## Open the frontend

<http://localhost:8000> is the front page once the server is up — choose **Make a Plot** and **Classic** or **Modern**. Opening `frontend/index.html` directly from disk works too. Classic is the compact desktop-style layout. Modern uses separate Measurements, Fit model, and Results pages. Both share the analysis and backend in `app.js`.

Modern includes a keyboard-operated equation editor. Type `A exp(-x/tau)+B`, `x_0`, `x^2`, or `sqrt`; common Greek names become symbols automatically. The Typing reference documents multiplication, constants, and supported functions. The editor translates the expression to ROOT and creates parameter fields; rearranging terms preserves parameter identities and initial guesses. ROOT expression mode supports ROOT-specific syntax that the visual editor cannot represent. Classic continues to use ROOT text entry.

Equation drafts and symbol mappings are saved per dataset, including incomplete drafts. An incomplete equation cannot submit the previous valid formula. Unchanged equations survive Classic/Modern switching; editing the ROOT formula invalidates its old visual representation. MathLive 0.110.0 and its fonts are bundled locally under `frontend/vendor/mathlive/` (MIT license); equation editing does not require a CDN. The parser uses an explicit arithmetic/function grammar and does not evaluate user JavaScript.

Both interfaces provide **Paste data…** beside the dataset selector. Paste a rectangular block from Excel with optional headers, inspect the first five rows, and assign X/Y/error columns (or a histogram measurement column). Names such as `u(Voltage)` are matched to their measurement column. Loading creates a new dataset by default; replacing the selected dataset requires confirmation and clears its old result. Blank or invalid mapped cells are reported rather than silently dropped. Tests: `node tests/paste_data_test.cjs`.

You can also open `frontend/classic.html` or `frontend/modern.html` directly.
Serving the pages from one address (which `./start` does) keeps autosave shared
when you switch between Classic and Modern. The page uses whichever origin
served it if that origin answers `/health`, and otherwise
`http://localhost:8000`; the "Backend URL" setting overrides both.

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

### Simultaneous fits

**Fit together…** (next to the dataset selector in Compact and Standard, and in
Compact's Fit menu) fits two or more XY datasets at once. Every parameter of
every model gets a role: **shared** (one value fitted to all datasets that use
it), **this dataset only**, or **fixed value**. Each dataset keeps its own
function, fit range, initial guesses and point exclusions. The backend
minimizes the sum of the per-dataset χ² values with `ROOT::Fit::Fitter` and a
combined FCN built from per-dataset `ROOT::Fit::Chi2Function` objects (the
pattern of ROOT's `combinedFit.C`), so X uncertainties enter through the same
effective-variance rule as single fits. NDF = fitted points in all datasets −
free unique parameters; the covariance matrix covers every unique parameter.

The report lists the shared parameters once, then each dataset's own
parameters, the totals, and every dataset's χ² contribution and point count.
The plot draws every dataset and its curve in its own colour with a legend;
optional plots overlay the datasets in the same colours. Results are stored on
the group (`inputs.simultaneous_fits` in the session JSON; absent in older
documents, which open unchanged), appear as one fit object in Analyze Data with
the full covariance, and are included in text, CSV, LaTeX and PDF exports.
Confidence bands are not available for simultaneous fits. The guide in
`frontend/documentation.html#simultaneous-fits` explains when a shared
parameter is appropriate and how to read the per-dataset χ² contributions.
`examples/two-decays-shared-tau.json` (also in the examples menus) is a
ready-made case.

`POST /simultaneous-fit` accepts `{"datasets": [{name, x, y, ex, ey, formula,
param_names, x_range, excluded_points}, …], "parameters": {"shared": [{name,
guess, min, max}], "mapping": [[{kind: "shared", ref} | {kind: "local", guess}
| {kind: "fixed", value}, …], …]}, title, x_title, y_title, plot}` and returns
`params[]` (with `kind`, `dataset`, `fixed`, `label`), `covariance`, `chi2`,
`ndf`, `prob`, `datasets[]` (each with `chi2`, `n_points`, `range`) and the
usual `canvas_json`.

Tests: `node tests/simultaneous_frontend_test.cjs` (session model, payload,
exact round trips, old documents, Analyze Data propagation against a hand
calculation) and, inside the ROOT container,
`./root-run python3 backend/simultaneous_test.py` (shared time constant
recovered with a smaller uncertainty than either run alone, all-local fits
equal to the individual fits including X uncertainties, NDF with fixed
parameters and exclusions, refused requests, canvas contents).
`python3 backend/simultaneous_reference.py` is the ROOT-free reference
minimizer the ROOT test compares against.

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

## Shared analysis session

Classic, Modern, and Analyze Data use **one document** and the `rootfit.autosave` browser key. Opening a session in any workspace replaces the same shared session. Saving in any workspace writes all datasets, per-dataset fit settings and results (including canvases and covariance), notes, quantities, calculation definitions, and source links to one JSON file. Browser autosave is not a permanent backup.

Datasets have stable IDs. Analyze Data shows a dataset box with Raw data and Fit results; no import or copy step is required. Pasted measurements become datasets available in the plotting interfaces. Calculated columns become linked plotting datasets; their Y values and uncertainties are regenerated from the calculation. Scalar quantities remain available for further calculations. Extra source columns and their metadata survive opening and saving in the plotting interfaces.

Fits are linked to the source dataset. Refitting updates calculations that use its parameters. Editing the raw data or model marks an old fit as stale and blocks propagation from it until refitted. Missing sources produce explicit errors. Mathematical propagation retains shared-input covariance; cross-covariance between measured data and an estimated fit parameter is not inferred. Separate input sources are treated as independent. Units remain labels, without automatic conversion or dimensional checking.

Old plotting JSON documents are accepted. Earlier `gauss-analysis` documents can also be opened in any workspace, and the old separate browser autosave is migrated into the shared session. No new data is written to the former DA storage key. Open tabs receive updates; revision checks prevent an older tab from silently overwriting newer work. Use Reload session in Analyze Data, or reload the plotting page, after resolving conflicting unsaved edits.

Run `node tests/workspace_store_test.cjs` for shared-session round trips, fit links, stale-result protection, metadata, old-document migration and revision checks. Run `node tests/analysis_test.cjs` for numerical propagation and covariance.

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

### Analysis features

- **Point exclusions** (XY data, Standard and Compact): uncheck rows and optionally record reasons. Original values remain in the session. Refit after changes; excluded measurements are open gray markers and do not enter the fit or diagnostics. If excluded row values or positions change, review exclusions before fitting again.
- **Calculated columns** (Analyze Data): select Calculated column as the result type, insert source columns, and enter an expression. Values and first-order propagated standard uncertainties appear alongside their source dataset and update from the stored calculation. Separate inputs are assumed independent except where fit covariance or shared input identities are available. Units are labels, not automatic conversions.
- **Correlation matrix**: available below the fit report and in Analyze Data. Undefined zero-variance correlations are shown as a dash.
- **Confidence bands**: choose None, 68%, 95%, or 99% under plot settings and refit. ROOT computes pointwise linearized covariance intervals, without extra chi-square normalization. These are not simultaneous bands or prediction intervals. Bands require a converged fit with an accurate covariance matrix. Histogram bands describe the fitted density (counts per unit X).
- **Export analysis**: downloads a ZIP with report.tex, PNG/SVG figures, CSV tables, calculation definitions/results, and the complete session.json. Select which datasets appear in the report; all calculations and the complete session remain in the bundle. Compile report.tex with XeLaTeX. The tool does not generate interpretations or conclusions.
