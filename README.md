# ROOT Fit — web-based curve fitting backed by CERN ROOT

A free, account-less redesign of the Clayton State `chi2` fitting tool
(<https://sos.clayton.edu/physics/chi2/>). Paste data, type a function, get
parameters with uncertainties, χ²/NDF, a p-value and a proper plot — all
computed by ROOT's fitter (Minuit), drawn in the browser by JSROOT.

```
backend/    Python + Flask + PyROOT, runs in a Docker container (rootproject/root)
frontend/   landing page, Classic, Modern, and native CLI interfaces (no build step)
examples/   sample saved documents (JSON) you can load into the page
tests/      reference datasets with independently known results
root-run    helper: run any command inside the ROOT container
```

The form backend stores no analysis data: `POST /fit` returns a result, and
the page saves your work in a JSON file you download ("Save") and re-open
("Load"). The separate native CLI service keeps temporary interpreter state
and working files for each active session, as described below.

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

Open `frontend/index.html` for the front page, then choose **Make a Plot** and **Classic**, **Modern**, or **Command Line Interface**. The Classic interface is the original compact layout; Modern uses full-width Data, Fit settings, and Results sections with the same functions in the shared `app.js`. Its section navigation is implemented in `modern.js`; sections can be visited in any order, and a completed fit opens Results automatically. **What is ROOT?** opens a short explanation and a link to the official website.

You can also open `frontend/classic.html`, `frontend/modern.html`, or `frontend/cli.html` directly. For shared autosave when switching between Classic and Modern, serve the pages from the same address. Serve the
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
- **Optional plots** include residuals, pulls, data/fit ratio, percentage difference, and a residual histogram. Select any combination under **Labels & plot → Plot options** (Classic) or **Fit settings → Labels and plot options** (Modern), then fit again. All are off by default. **Advanced optional plot settings** lets you rename each selected plot, set axis labels and Y limits, panel height, point scope, grids, reference lines, uncertainty bars, and histogram bins. Settings are saved with the document; older single-panel selections migrate automatically. Ratio and percentage uncertainty bars hold the fitted model fixed and are not model confidence bands. Undefined points are omitted with an explanatory message.
- **Export PNG** renders the current plot to an image.
- The form is autosaved in your browser (localStorage) so a reload does not
  lose your work; nothing leaves your machine except the fit request.

## Native ROOT Command Line Interface

The CLI is a general ROOT/C++ workspace, independent of the form views. It does
not use `app.js`, the `/fit` endpoint, or Classic/Modern autosave. Its own code,
connection, live interpreters, session files, and saved-document format are
kept separate. `style.css` and `modern.css` provide the shared visual styling.

For local development, the operator starts the website and native service from the project folder:

```sh
./root-cli
```

The launcher waits for the backend and opens the connected CLI in your browser.
It also prints the website address (normally
`http://127.0.0.1:8080/cli.html`). The launcher selects a free backend port;
if the default website port is busy, it selects a free website port too.
Existing instances remain running. Press Ctrl+C in the launcher's terminal
to stop that instance. Users select **Run** (or Ctrl/Cmd+Enter)
to start a session and submit native ROOT/C++. They do not enter service
addresses or access keys. There is no plotting-specific command language. For example:

```cpp
auto c = new TCanvas("surface_canvas", "3D surface", 900, 650);
auto f = new TF2("surface", "sin(x)*cos(y)", -3, 3, -3, 3);
f->Draw("surf1");
```

Variables remain available between submissions. Each session has its own
worker process and working directory. **Session files** uploads data/macros
and downloads files created there, including `.root` files. Uploading does
not execute a file; use native commands such as `.x example.C` or `.L example.C`.
The file list shows regular files at the top level of the working directory.
**Canvases** selects among the live interpreter's canvas snapshots; JSROOT
renders supported ROOT objects and exports PNG/SVG.

**Save session** stores command history, editor input and canvas snapshots in
a CLI-only JSON document. **Open** restores those without executing commands;
it can also place a C++ text file in the editor. Saving does not serialize C++
memory or temporary files. Download working files separately before ending a
session. Opening a snapshot does not recreate interpreter variables. Compiler
errors are shown with ROOT's diagnostic text; statements before an error may
have already run. Command history uses Alt + arrow keys, or unmodified arrow keys in single-line input.

`root-cli` launches a dedicated, non-root Docker container bound only to the
host's loopback interface, with a read-only root filesystem, temporary writable
storage, no host mounts, dropped capabilities and memory/CPU/process limits.
The web gateway serves the frontend and handles `/api/root` requests on the
same website origin. It generates browser ownership cookies automatically
(HttpOnly, SameSite=Strict) and checks session ownership on every request.
The private service credential stays in the gateway and native-service
processes; it is never sent to the browser, printed, or saved in a document.
Cross-origin API requests are rejected. Old browser-stored access keys are
removed automatically. Native C++ has the
permissions of this container; this is a local single-user tool, not a public
multi-tenant execution service. Sessions within the CLI container are separate
interpreters, not security boundaries from one another. Do not publish its port.

Each submission is limited to 45 seconds, uploads to 20 MB, and canvas responses
to 24 MB. Four sessions can run concurrently; idle interpreters expire after an
hour. Stopping or timing out an interpreter removes its live variables and
working files, while browser history and existing canvas snapshots remain.

Operator settings: `ROOT_WEB_PORT` changes the website port (default 8080);
`ROOT_WEB_BIND` defaults to loopback. For an HTTPS reverse proxy, set
`ROOT_SITE_ORIGIN` to the exact public origin, preserve the original Host
header, and forward both the frontend and `/api/root` to the gateway.
`ROOT_NATIVE_URL` and `ROOT_CLI_TOKEN` configure a separately managed private
ROOT service; the launcher supplies these defaults automatically. Static-only
serving or opening `cli.html` from disk does not provide the CLI API.

Run gateway checks with `python3 -m unittest discover -s backend -p gateway_test.py`.
Run native regression checks with
`docker run --rm --platform linux/amd64 rootfit-backend python3 -m unittest native_test.py`
and document-format checks with `node tests/cli_session_test.cjs`.

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
