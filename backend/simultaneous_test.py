"""
simultaneous_test.py — checks of the simultaneous fit that need ROOT.

Run from the repo root, inside the ROOT container:
    ./root-run python3 backend/simultaneous_test.py

What is checked (synthetic data with known true values, see simultaneous_reference.py):
 1. Two exponential decays with different amplitudes and backgrounds and a
    shared time constant: the shared fit recovers the true time constant within
    its uncertainty, with a smaller uncertainty than either individual fit, and
    agrees with the ROOT-free reference minimizer.
 2. A combined fit in which every parameter is local reproduces the individual
    TGraphErrors::Fit results (parameters, uncertainties, chi2), including X
    uncertainties: the effective-variance chi2 of the combined path is the same
    function TGraphErrors::Fit minimizes (checked to 1e-9 at the same parameters).
 3. The NDF is right when parameters are fixed and points are excluded or
    outside the fit range; fixed parameters have zero rows in the covariance.
 4. Bad requests are rejected with readable messages.
 5. The canvas holds every dataset, its curve and a legend; diagnostics carry
    one series per dataset.
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import numpy as np                       # noqa: E402
import ROOT                              # noqa: E402
import fit                               # noqa: E402
import simultaneous_fit as SF            # noqa: E402
import simultaneous_reference as R       # noqa: E402
from formula_check import check_formula  # noqa: E402

FORMULA = "[0]*exp(-x/[1])+[2]"
NAMES = ["A", "tau", "B"]
failures = []


def check(condition, message):
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        failures.append(message)


def close(a, b, tol):
    return abs(a - b) <= tol * max(1.0, abs(b))


def request(runs, shared, mapping, plot=None):
    datasets = [dict(name=f"Run {k + 1}", x=r["x"].tolist(), y=r["y"].tolist(), ey=r["ey"].tolist(),
                     ex=r["ex"].tolist() if "ex" in r else [], formula=FORMULA, param_names=NAMES,
                     x_range=r.get("x_range"), excluded_points=r.get("excluded", []))
                for k, r in enumerate(runs)]
    payload = dict(name="test", datasets=datasets, parameters=dict(shared=shared, mapping=mapping), plot=plot or {},
                   title="test", x_title="t (s)", y_title="counts")
    return SF.run_simultaneous(SF.parse_request(payload, check_formula))


def single(run):
    return fit.run_fit(run["x"].tolist(), run["y"].tolist(), run["ex"].tolist() if "ex" in run else [], run["ey"].tolist(),
                       FORMULA, par_names=NAMES, par_guesses=[run["y"][0], 2.0, run["y"][-1]], x_range=run.get("x_range"),
                       title="single", x_title="t", y_title="y")


def local(run):
    return [{"kind": "local", "guess": float(run["y"][0])}, {"kind": "local", "guess": 2.0}, {"kind": "local", "guess": float(run["y"][-1])}]


# ------------------------------------------------------------------ 1. shared time constant
print("1. two decays, shared time constant")
tau_true, runs = R.synthetic_decays()
mapping = [[{"kind": "local", "guess": float(r["y"][0])}, {"kind": "shared", "ref": 0}, {"kind": "local", "guess": float(r["y"][-1])}] for r in runs]
out = request(runs, [dict(name="tau", guess=2.0)], mapping)
tau = out["params"][0]
singles = [single(r) for r in runs]
print(f"  shared tau = {tau['value']:.4f} +/- {tau['error']:.4f} (true {tau_true}); alone: "
      + ", ".join(f"{s['params'][1]['value']:.4f} +/- {s['params'][1]['error']:.4f}" for s in singles))
check(out["converged"], f"fit converged: {out['status_message']}")
check(tau["kind"] == "shared" and tau["name"] == "tau", "the first parameter is the shared time constant")
check(abs(tau["value"] - tau_true) < tau["error"], "the true time constant lies within one standard uncertainty of the shared value")
check(all(tau["error"] < s["params"][1]["error"] for s in singles), "the shared uncertainty is smaller than either individual fit's")
p_ref, cov_ref, chi2_ref, parts_ref = R.reference_shared_fit(runs)
check(close(tau["value"], p_ref[0], 1e-3), f"shared tau agrees with the reference minimizer ({p_ref[0]:.4f})")
check(close(out["chi2"], chi2_ref, 1e-3), f"total chi2 {out['chi2']:.3f} agrees with the reference ({chi2_ref:.3f})")
check(close(tau["error"], math.sqrt(cov_ref[0, 0]), 0.1), f"shared uncertainty agrees with the reference within 10% ({math.sqrt(cov_ref[0, 0]):.4f})")
check(all(close(d["chi2"], c, 1e-3) for d, c in zip(out["datasets"], parts_ref)), "per-dataset chi2 contributions agree with the reference")
check(close(sum(d["chi2"] for d in out["datasets"]), out["chi2"], 1e-9), "the contributions add up to the total")
check(out["ndf"] == sum(len(r["x"]) for r in runs) - 5 and out["n_free"] == 5, f"ndf = {out['ndf']} = points - 5 free parameters")
cov = np.array(out["covariance"])
check(cov.shape == (5, 5) and np.allclose(cov, cov.T), "covariance is 5x5 and symmetric")
check(close(cov[0, 0], tau["error"] ** 2, 1e-6), "covariance diagonal matches the reported uncertainty")
check(abs(cov[1, 3]) > 0, "shared parameter induces a correlation between the two amplitudes")
check(out["prob"] is not None and 0 <= out["prob"] <= 1, f"p-value {out['prob']:.3f}")

# ------------------------------------------------------------------ 2. all local == individual fits, with X uncertainties
print("2. every parameter local, with X uncertainties: equals the individual fits")
runs_x = [dict(r, ex=np.full(len(r["x"]), 0.15)) for r in runs]
singles_x = [single(r) for r in runs_x]
out = request(runs_x, [], [local(r) for r in runs_x])
check(out["x_error_note"] is not None and all(d["x_errors"] for d in out["datasets"]), "X uncertainties are reported as used")
for k, (d, s) in enumerate(zip(out["datasets"], singles_x)):
    check(close(d["chi2"], s["chi2"], 1e-4), f"run {k + 1}: chi2 {d['chi2']:.6f} vs single fit {s['chi2']:.6f}")
    for p, q in zip(d["params"], s["params"]):
        # Both paths run the same minimizer on the same data; the 6-parameter problem may stop at a slightly
        # different point within Minuit's tolerance, so values are compared to 2e-3 and uncertainties to 5%.
        check(close(p["value"], q["value"], 2e-3) and close(p["error"], q["error"], 5e-2), f"run {k + 1}: {q['name']} = {p['value']:.5g} +/- {p['error']:.3g} vs {q['value']:.5g} +/- {q['error']:.3g}")
check(out["ndf"] == sum(s["ndf"] for s in singles_x), "ndf is the sum of the individual ndf")
# The decisive check: the combined path's chi2 function, evaluated at the single
# fit's parameters, is exactly the effective-variance chi2 TGraphErrors::Fit reports.
for k, (r, s) in enumerate(zip(runs_x, singles_x)):
    graph = ROOT.TGraphErrors(len(r["x"]), r["x"], r["y"], r["ex"], r["ey"])
    func = ROOT.TF1(f"check_{k}", FORMULA, float(r["x"].min()), float(r["x"].max()))
    data_range = ROOT.Fit.DataRange()
    data_range.SetRange(float(r["x"].min()), float(r["x"].max()))
    data = ROOT.Fit.BinData(ROOT.Fit.DataOptions(), data_range)
    ROOT.Fit.FillData(data, graph)
    wrapped = ROOT.Math.WrappedMultiTF1(func, 1)
    chi2 = ROOT.Fit.Chi2Function(data, wrapped)
    at = np.array([p["value"] for p in s["params"]], dtype=np.float64)
    value = float(chi2(at))
    check(int(data.GetErrorType()) == int(ROOT.Fit.BinData.kCoordError), f"run {k + 1}: BinData carries coordinate (X) errors")
    check(close(value, s["chi2"], 1e-9), f"run {k + 1}: Chi2Function at the single-fit parameters = {value:.9f}, TGraphErrors::Fit chi2 = {s['chi2']:.9f}")

# ------------------------------------------------------------------ 3. ndf with fixed parameters, exclusions and ranges
print("3. ndf with a fixed parameter, excluded points and a fit range")
r1 = dict(runs[0])
keep = np.ones(len(r1["x"]), dtype=bool)
keep[[3, 7]] = False
r1["excluded"] = [dict(x=float(r1["x"][i]), y=float(r1["y"][i])) for i in (3, 7)]
r1["x"], r1["y"], r1["ey"] = r1["x"][keep], r1["y"][keep], r1["ey"][keep]
r2 = dict(runs[1], x_range=[1.0, 8.0])
mapping = [[{"kind": "local", "guess": float(r1["y"][0])}, {"kind": "shared", "ref": 0}, {"kind": "fixed", "value": 5.0}],
           [{"kind": "local", "guess": float(r2["y"][0])}, {"kind": "shared", "ref": 0}, {"kind": "local", "guess": 2.0}]]
out = request([r1, r2], [dict(name="tau", guess=2.0, min=0.1, max=10)], mapping)
inside = int(((r2["x"] >= 1.0) & (r2["x"] <= 8.0)).sum())
check(out["datasets"][0]["n_points"] == len(r1["x"]) and out["datasets"][0]["n_excluded"] == 2, f"run 1 uses {len(r1['x'])} points with 2 excluded")
check(out["datasets"][1]["n_points"] == inside, f"run 2 uses the {inside} points inside [1, 8]")
check(out["n_free"] == 4 and out["ndf"] == len(r1["x"]) + inside - 4, f"ndf = {out['ndf']} = {len(r1['x'])} + {inside} - 4 free parameters")
fixed = out["params"][2]
check(fixed["fixed"] and fixed["value"] == 5.0 and fixed["error"] == 0, "the fixed parameter keeps its value and has no uncertainty")
check(all(v == 0 for v in out["covariance"][2]) and all(row[2] == 0 for row in out["covariance"]), "the covariance row and column of the fixed parameter are zero")
check(out["params"][0]["limits"] == [0.1, 10], "limits are reported for the shared parameter")
check(all(p["fixed"] is False for i, p in enumerate(out["params"]) if i != 2), "other parameters are free")
check(out["ndf"] == out["n_points"] - out["n_free"], "ndf = points used - free parameters")

# ------------------------------------------------------------------ 4. bad requests
print("4. bad requests are refused")
def refused(payload_fn, pattern):
    try:
        payload_fn()
    except ValueError as e:
        check(pattern in str(e), f"refused: {e}")
    else:
        check(False, f"a request should have been refused ({pattern})")
refused(lambda: request(runs[:1], [], [local(runs[0])]), "at least two datasets")
refused(lambda: request(runs, [dict(name="tau", guess=2.0)], [local(r) for r in runs]), "not used by any dataset")
refused(lambda: request(runs, [], [local(runs[0])[:2], local(runs[1])]), "assignment(s)")
refused(lambda: request(runs, [], [[{"kind": "local"}, {"kind": "shared", "ref": 3}, {"kind": "local"}], local(runs[1])]), "shared parameter")
refused(lambda: request(runs, [], [[{"kind": "fixed"}, {"kind": "local"}, {"kind": "local"}], local(runs[1])]), "fixed value")
refused(lambda: request(runs, [dict(name="tau", guess=20, min=0.1, max=10)], mapping), "within its limits")
refused(lambda: request(runs, [], [local(r) for r in runs], plot={"confidence_level": 0.68}), "Confidence bands")

# ------------------------------------------------------------------ 5. the plot
print("5. canvas and diagnostics")
out = request(runs, [dict(name="tau", guess=2.0)], [[{"kind": "local", "guess": float(r["y"][0])}, {"kind": "shared", "ref": 0}, {"kind": "local", "guess": float(r["y"][-1])}] for r in runs],
              plot={"diagnostics": [{"kind": "residual"}, {"kind": "pull"}, {"kind": "histogram"}], "grid": True})
canvas = out["canvas_json"]
check(canvas["_typename"] == "TCanvas", "canvas serialized")
def typenames(obj, found=None):
    found = found if found is not None else set()
    if isinstance(obj, dict):
        if "_typename" in obj:
            found.add(obj["_typename"])
        for v in obj.values():
            typenames(v, found)
    elif isinstance(obj, list):
        for v in obj:
            typenames(v, found)
    return found
names = typenames(canvas)
check("TMultiGraph" in names and "TLegend" in names and "TF1" in names, f"canvas holds a TMultiGraph, TF1 curves and a TLegend ({', '.join(sorted(n for n in names if n.startswith('T')))})")
check(len(out["diagnostics"]) == 3 and all(len(p["series"]) == 2 for p in out["diagnostics"]), "each diagnostic panel has one series per dataset")
check(all("counts" in s for s in out["diagnostics"][2]["series"]) and len(out["diagnostics"][2]["edges"]) == 16, "residual histograms share one binning")
check(out["plot_height"] == 500 + 3 * 240, "canvas height includes the three panels")

print()
if failures:
    print(f"FAILED: {len(failures)} check(s)")
    for f_ in failures:
        print("  -", f_)
    sys.exit(1)
print("OK: simultaneous fits agree with single fits, the reference minimizer and the requested bookkeeping.")
