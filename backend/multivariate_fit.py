"""
multivariate_fit.py — the general R^n -> R^m least-squares fit, in ROOT.

This is the multivariate counterpart of fit.py. Where fit.py handles one input
and one output (a TGraphErrors + TF1), this file fits a vector of measured
outputs that each depend on a vector of inputs, sharing one global parameter
vector. It is the only multivariate file that talks to ROOT.

Model
-----
N points; point i has an input vector x_i in R^n and outputs y_i in R^m. There
are m component formulas f_0..f_{m-1}, each a function of the inputs written
with x0, x1, ... and parameters [0], [1], ... . Parameters are shared BY INDEX
across the components: [j] is the same global parameter p[j] wherever it
appears, so a parameter used by two outputs is shared and one used by a single
output is that output's own. The global parameter count P is (highest index + 1).

Objective (effective-variance chi-square, the same convention as fit.py)
-----------------------------------------------------------------------
    s_eff[i,k]^2 = sy[i,k]^2 + sum_d ( df_k/dx_d(x_i; p) * sx[i,d] )^2
    chi2(p)      = sum_{i,k} ( (y[i,k] - f_k(x_i; p)) / s_eff[i,k] )^2
An entry whose effective uncertainty is zero gets weight 1 (unweighted), like
TGraph::Fit. X-uncertainties enter through a numeric central-difference
derivative, re-evaluated as the parameters change.

The numbers this file produces are cross-checked against multivariate_reference.py
(pure numpy/scipy) by multivariate_test.py.
"""

import json
import re
from array import array

import numpy as np
import ROOT

ROOT.gROOT.SetBatch(True)
ROOT.gErrorIgnoreLevel = ROOT.kError
ROOT.gStyle.SetOptStat(0)

STATUS_MESSAGES = {
    0: "Fit converged.",
    1: "Covariance matrix was made positive-definite (errors are approximate).",
    2: "Hesse matrix is invalid (errors are not reliable).",
    3: "Estimated distance to minimum is above the limit (did not fully converge).",
    4: "Reached the maximum number of function calls (did not converge).",
    5: "Fit failed for another reason (see server log).",
}

_UID = [0]


def _uid():
    _UID[0] += 1
    return _UID[0]


def _safe_title(text):
    return str(text or "").replace(";", ",")


def _to_root(expr):
    """UI syntax -> ROOT TFormula syntax: x0 -> x[0], x1 -> x[1], ... .
    Parameter tokens [0], [1], ... are already ROOT syntax."""
    return re.sub(r"\bx(\d+)\b", r"x[\1]", str(expr))


def _sub(expr, mapping):
    """Rewrite a UI formula for drawing: mapping maps an input index to the
    string that replaces x{index} (e.g. 'x', 'y', or a numeric literal)."""
    def repl(m):
        d = int(m.group(1))
        return mapping.get(d, m.group(0))
    return re.sub(r"\bx(\d+)\b", repl, str(expr))


def n_params(models):
    hi = -1
    for m in models:
        for tok in re.findall(r"\[(\d+)\]", str(m)):
            hi = max(hi, int(tok))
    return hi + 1


def _broadcast_err(col, N):
    a = np.asarray(col, dtype=float) if col is not None else np.zeros(0)
    if a.size == 0:
        return np.zeros(N)
    if a.size == 1:
        return np.full(N, float(a[0]))
    return a


def run_multivariate(inputs, outputs, models,
                     input_errors=None, output_errors=None,
                     param_names=None, param_guesses=None,
                     input_names=None, output_names=None,
                     input_ranges=None, title="", plot=None):
    plot = plot or {}
    X = [np.asarray(c, dtype=float) for c in inputs]
    Y = [np.asarray(c, dtype=float) for c in outputs]
    n = len(X)
    m = len(Y)
    if n == 0 or m == 0:
        raise ValueError("Provide at least one input column and one output column.")
    N = len(X[0])
    if N == 0:
        raise ValueError("Enter some measurements before fitting.")
    for d in range(n):
        if len(X[d]) != N:
            raise ValueError(f"Input column {d + 1} has {len(X[d])} values but input 1 has {N}.")
    for k in range(m):
        if len(Y[k]) != N:
            raise ValueError(f"Output column {k + 1} has {len(Y[k])} values but there are {N} points.")
    if len(models) != m:
        raise ValueError(f"Give one model per output: {m} outputs but {len(models)} formula(s).")

    input_names = list(input_names or []) + [f"x{d}" for d in range(n)]
    output_names = list(output_names or []) + [f"y{k}" for k in range(m)]
    input_names = [input_names[d] or f"x{d}" for d in range(n)]
    output_names = [output_names[k] or f"y{k}" for k in range(m)]

    SX = [_broadcast_err(input_errors[d] if input_errors else None, N) for d in range(n)]
    SY = [_broadcast_err(output_errors[k] if output_errors else None, N) for k in range(m)]
    for d in range(n):
        if (SX[d] < 0).any():
            raise ValueError(f"Uncertainties on {input_names[d]} must be zero or positive.")
    for k in range(m):
        if (SY[k] < 0).any():
            raise ValueError(f"Uncertainties on {output_names[k]} must be zero or positive.")

    P = n_params(models)
    if P == 0:
        raise ValueError("The model has no parameters to fit. Use [0], [1], ... for fit parameters.")

    formulas = []
    for k, s in enumerate(models):
        root_expr = _to_root(s)
        f = ROOT.TFormula(f"mv_{_uid()}", root_expr)
        if not f.IsValid():
            raise ValueError(f"ROOT could not read the model for {output_names[k]}: {s!r}")
        if f.GetNdim() > n:
            raise ValueError(f"The model for {output_names[k]} uses an input beyond x{n - 1}.")
        formulas.append(f)

    # fit-range mask: keep points inside every provided per-input range
    mask = np.ones(N, dtype=bool)
    if input_ranges:
        for d, rng in enumerate(input_ranges):
            if rng not in (None, "", []):
                lo, hi = float(rng[0]), float(rng[1])
                if not lo < hi:
                    raise ValueError(f"Fit range on {input_names[d]}: from must be smaller than to.")
                mask &= (X[d] >= lo) & (X[d] <= hi)
    idx = np.where(mask)[0]
    if idx.size * m <= P:
        raise ValueError(f"Not enough measurements inside the fit range: {idx.size} point(s) "
                         f"for {P} parameter(s). Add data or widen the range.")

    coords = [array("d", [float(X[d][i]) for d in range(n)]) for i in range(N)]
    has_x_err = any((SX[d] > 0).any() for d in range(n))

    def s_eff(k, i, p):
        var = float(SY[k][i]) ** 2
        if has_x_err:
            xi = coords[i]
            for d in range(n):
                sxd = float(SX[d][i])
                if sxd > 0:
                    h = abs(xi[d]) * 1e-6 or 1e-6
                    plus = array("d", xi)
                    minus = array("d", xi)
                    plus[d] += h
                    minus[d] -= h
                    deriv = (formulas[k].EvalPar(plus, p) - formulas[k].EvalPar(minus, p)) / (2 * h)
                    var += (deriv * sxd) ** 2
        s = var ** 0.5
        return s if s > 0 else 1.0

    def chi2(par):
        p = array("d", [par[j] for j in range(P)])
        total = 0.0
        for i in idx:
            ci = coords[i]
            for k in range(m):
                pred = formulas[k].EvalPar(ci, p)
                r = (float(Y[k][i]) - pred) / s_eff(k, i, p)
                total += r * r
        return total

    functor = ROOT.Math.Functor(chi2, P)
    fitter = ROOT.Fit.Fitter()
    p0 = array("d", [0.0] * P)
    for j in range(P):
        g = None
        if param_guesses and j < len(param_guesses):
            g = param_guesses[j]
        p0[j] = float(g) if g not in (None, "") else 1.0

    # chi2fit=True: Minuit uses errordef 1 and dataSize sets the ndf.
    fitter.SetFCN(functor, p0, int(idx.size * m), True)
    for j in range(P):
        settings = fitter.Config().ParSettings(j)
        if param_names and j < len(param_names) and param_names[j]:
            settings.SetName(str(param_names[j]))
        else:
            settings.SetName(f"p{j}")

    ok = fitter.FitFCN()
    result = fitter.Result()
    status = int(result.Status())
    ndf = int(result.Ndf()) if result.Ndf() else (idx.size * m - P)
    chi2_value = float(result.MinFcnValue())
    fitted = [float(result.Parameter(j)) for j in range(P)]

    def _pname(j):
        if param_names and j < len(param_names) and param_names[j]:
            return str(param_names[j])
        return f"p{j}"
    params = [
        {
            "index": j,
            "name": _pname(j),
            "value": fitted[j],
            "error": float(result.Error(j)),
        }
        for j in range(P)
    ]
    cov = [[float(result.CovMatrix(i, j)) for j in range(P)] for i in range(P)]

    # residual / pull diagnostics (dimension-independent)
    fitted_arr = array("d", fitted)
    per_output = []
    all_pulls = []
    for k in range(m):
        res_k, pull_k = [], []
        for i in idx:
            pred = formulas[k].EvalPar(coords[i], fitted_arr)
            r = float(Y[k][i]) - pred
            se = s_eff(k, i, fitted_arr)
            res_k.append(r)
            pull_k.append(r / se if se else 0.0)
        rms = float(np.sqrt(np.mean(np.square(res_k)))) if res_k else 0.0
        per_output.append({
            "name": output_names[k],
            "rms_residual": rms,
            "mean_pull": float(np.mean(pull_k)) if pull_k else 0.0,
            "std_pull": float(np.std(pull_k)) if pull_k else 0.0,
        })
        all_pulls.extend(pull_k)

    converged = status == 0 and result.IsValid()
    prob = float(ROOT.TMath.Prob(chi2_value, ndf)) if ndf > 0 else None

    out = {
        "analysis_type": "multivariate",
        "status": status,
        "converged": converged,
        "status_message": STATUS_MESSAGES.get(status, f"Minuit status {status}"),
        "n_inputs": n,
        "n_outputs": m,
        "n_points": int(idx.size),
        "input_names": input_names,
        "output_names": output_names,
        "models": [str(s) for s in models],
        "params": params,
        "chi2": chi2_value,
        "ndf": ndf,
        "chi2_ndf": (chi2_value / ndf) if ndf > 0 else None,
        "prob": prob,
        "covariance": cov,
        "residual_summary": per_output,
        "pull_mean": float(np.mean(all_pulls)) if all_pulls else 0.0,
        "pull_std": float(np.std(all_pulls)) if all_pulls else 0.0,
        "plot_notes": [],
    }
    out.update(_render(X, Y, SX, SY, models, fitted, idx, n, m,
                       input_names, output_names, title, out["plot_notes"]))
    return out


# ------------------------------------------------------------------ plotting
def _render(X, Y, SX, SY, models, fitted, idx, n, m,
            input_names, output_names, title, notes):
    """Build a TCanvas the browser can draw with JSROOT.

      n == 1 : each output vs the single input, with its fitted curve.
      n == 2 : each output as a fitted surface (TF2) over the data points.
      n >= 3 : each output sliced along the first input, the others held at
               their mean; the fitted curve with a scatter of the data.
    """
    keep = []
    if m > 6:
        notes.append("Plot omitted: more than six outputs. The fit and diagnostics below are complete.")
        return {"plot_height": None, "canvas_json": None}

    ncol = 1 if m == 1 else 2
    nrow = int(np.ceil(m / ncol))
    canvas = ROOT.TCanvas(f"mv_c_{_uid()}", "", 480 * ncol, 360 * nrow)
    canvas.Divide(ncol, nrow)
    fitted_arr = array("d", fitted)

    xi = np.asarray(X[0], dtype=float)[idx]
    for k in range(m):
        pad = canvas.cd(k + 1)
        pad.SetGrid()
        yk = np.asarray(Y[k], dtype=float)[idx]
        syk = np.asarray(SY[k], dtype=float)[idx]

        if n == 1:
            ex = np.zeros(idx.size)
            g = ROOT.TGraphErrors(idx.size, array("d", xi), array("d", yk),
                                  array("d", ex), array("d", syk))
            g.SetTitle(f"{_safe_title(output_names[k])} vs {_safe_title(input_names[0])};"
                       f"{_safe_title(input_names[0])};{_safe_title(output_names[k])}")
            g.SetMarkerStyle(20)
            g.SetMarkerSize(0.9)
            g.Draw("AP")
            expr = _sub(models[k], {0: "x"})
            curve = ROOT.TF1(f"mv_f_{_uid()}", expr, float(xi.min()), float(xi.max()))
            for j in range(min(curve.GetNpar(), len(fitted))):
                curve.SetParameter(j, fitted[j])
            curve.SetNpx(400)
            curve.SetLineColor(ROOT.kRed)
            curve.Draw("SAME")
            keep += [g, curve]

        elif n == 2:
            x1 = np.asarray(X[1], dtype=float)[idx]
            g2 = ROOT.TGraph2D(idx.size, array("d", xi), array("d", x1), array("d", yk))
            g2.SetTitle(f"{_safe_title(output_names[k])};"
                        f"{_safe_title(input_names[0])};{_safe_title(input_names[1])};"
                        f"{_safe_title(output_names[k])}")
            g2.SetMarkerStyle(20)
            g2.SetMarkerSize(0.8)
            expr = _sub(models[k], {0: "x", 1: "y"})
            surf = ROOT.TF2(f"mv_s_{_uid()}", expr,
                            float(xi.min()), float(xi.max()),
                            float(x1.min()), float(x1.max()))
            for j in range(min(surf.GetNpar(), len(fitted))):
                surf.SetParameter(j, fitted[j])
            surf.SetNpx(60)
            surf.SetNpy(60)
            surf.SetLineColorAlpha(ROOT.kRed, 0.4)
            surf.SetTitle(g2.GetTitle())
            surf.Draw("surf1")
            g2.Draw("P SAME")
            keep += [g2, surf]

        else:  # n >= 3: slice along input 0, others at their mean
            means = {d: float(np.asarray(X[d], dtype=float)[idx].mean()) for d in range(1, n)}
            g = ROOT.TGraphErrors(idx.size, array("d", xi), array("d", yk),
                                  array("d", np.zeros(idx.size)), array("d", syk))
            g.SetTitle(f"{_safe_title(output_names[k])} vs {_safe_title(input_names[0])} "
                       f"(other inputs at mean);{_safe_title(input_names[0])};{_safe_title(output_names[k])}")
            g.SetMarkerStyle(24)
            g.SetMarkerSize(0.8)
            g.SetMarkerColor(ROOT.kGray + 2)
            g.Draw("AP")
            mapping = {0: "x"}
            for d, val in means.items():
                mapping[d] = f"({val!r})"
            expr = _sub(models[k], mapping)
            curve = ROOT.TF1(f"mv_f_{_uid()}", expr, float(xi.min()), float(xi.max()))
            for j in range(min(curve.GetNpar(), len(fitted))):
                curve.SetParameter(j, fitted[j])
            curve.SetNpx(400)
            curve.SetLineColor(ROOT.kRed)
            curve.Draw("SAME")
            keep += [g, curve]
            if k == 0:
                notes.append("Plots show each output along " + input_names[0]
                             + "; the other inputs are held at their mean. The fit itself uses all inputs.")

    canvas.Update()

    def to_dict(obj):
        return json.loads(str(ROOT.TBufferJSON.ToJSON(obj)))

    payload = {"plot_height": 360 * nrow, "canvas_json": to_dict(canvas)}
    canvas.Close()
    return payload
