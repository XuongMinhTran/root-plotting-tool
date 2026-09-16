"""
fit.py — the core fitting routine. This is the only file that talks to ROOT.

It takes plain Python lists (x, y, errors), builds a TGraphErrors, fits a TF1
to it, and returns a plain dict that Flask can turn into JSON. It also returns
the finished ROOT canvas serialised with TBufferJSON so the browser can draw
exactly what ROOT would draw (via JSROOT), instead of re-implementing plotting.

Runs inside the ROOT container, e.g. for a quick self-test:
    ./root-run python3 backend/fit_test.py
"""

import json

import numpy as np
import ROOT

ROOT.gROOT.SetBatch(True)                 # never open a graphics window
ROOT.gErrorIgnoreLevel = ROOT.kError      # hide ROOT "Warning:" chatter in the server log

# What the statistics box on the plot shows (ROOT's OptFit code, digits = pcev):
#   p = probability, c = chi2/ndf, e = parameter errors, v = parameter values.
ROOT.gStyle.SetOptFit(1111)
ROOT.gStyle.SetOptStat(0)                 # no histogram-style "Entries/Mean" box

# Minuit status codes, as documented for TFitResult::Status() / TMinuit.
# 0 is the only "all good" value; the others still return numbers but the
# uncertainties may not be trustworthy.
STATUS_MESSAGES = {
    0: "Fit converged.",
    1: "Covariance matrix was made positive-definite (errors are approximate).",
    2: "Hesse matrix is invalid (errors are not reliable).",
    3: "Estimated distance to minimum is above the limit (did not fully converge).",
    4: "Reached the maximum number of function calls (did not converge).",
    5: "Fit failed for another reason (see server log).",
}


def _safe_title(text):
    """ROOT reads 'title;x-title;y-title' from one string, so a ';' typed by the
    user would be misread as a separator. Replace it with a comma."""
    return str(text or "").replace(";", ",")


def run_fit(x, y, ex=None, ey=None, formula="pol1",
            par_names=None, par_guesses=None, x_range=None,
            title="", x_title="", y_title="", plot=None):
    """
    Fit a function to (x, y) data with optional errors.

    x, y        : lists of floats
    ex, ey      : lists of errors, or None/[] (treated as zero)
    formula     : TFormula string ("[0]*x+[1]") or named function ("gaus", "pol2", ...)
    par_names   : list of str, may be shorter than the number of parameters
    par_guesses : list of float (or None entries), may be shorter than the number of parameters
    x_range     : (xmin, xmax) or None -> use the data range
    title, x_title, y_title : plot labels
    plot        : dict of drawing options: {"logx": bool, "logy": bool, "grid": bool}

    Returns a plain dict (JSON-serialisable). Raises ValueError for bad input.
    """
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    n = len(x)
    if n == 0 or len(y) != n:
        raise ValueError("x and y must be non-empty and have the same number of points")

    ex = np.zeros(n) if ex is None or len(ex) == 0 else np.asarray(ex, dtype=float)
    ey = np.zeros(n) if ey is None or len(ey) == 0 else np.asarray(ey, dtype=float)
    if len(ex) != n or len(ey) != n:
        raise ValueError("error columns must have the same number of points as x and y")
    if (ex < 0).any() or (ey < 0).any():
        raise ValueError("errors must not be negative")

    if x_range is None:
        xmin, xmax = float(x.min()), float(x.max())
    else:
        xmin, xmax = float(x_range[0]), float(x_range[1])
        if not xmin < xmax:
            raise ValueError("fit range: xmin must be smaller than xmax")
    if xmin == xmax:
        raise ValueError("all x values are identical, nothing to fit against")

    # --- the data ----------------------------------------------------------
    graph = ROOT.TGraphErrors(n, x, y, ex, ey)
    graph.SetName("data")
    graph.SetTitle(f"{_safe_title(title)};{_safe_title(x_title)};{_safe_title(y_title)}")
    graph.SetMarkerStyle(20)          # filled circles, like the original tool
    graph.SetMarkerSize(0.9)

    # --- the model ---------------------------------------------------------
    # The TF1 range is what option "R" (below) will use as the fit range.
    func = ROOT.TF1("fit", formula, xmin, xmax)
    if not func.IsValid():
        raise ValueError(f"ROOT could not parse the formula: {formula!r}")
    func.SetNpx(400)                  # smooth curve when drawn / saved
    func.SetLineColor(ROOT.kRed)

    npar = func.GetNpar()
    for i, name in enumerate(par_names or []):
        if i < npar and name:
            func.SetParName(i, str(name))
    for i, guess in enumerate(par_guesses or []):
        if i < npar and guess is not None and guess != "":
            func.SetParameter(i, float(guess))

    # --- the fit -----------------------------------------------------------
    # Options:  S  return a TFitResultPtr so we can read chi2, ndf, covariance
    #           Q  quiet (no Minuit printout in the server log)
    #           R  fit only inside the TF1 range [xmin, xmax] set above
    # X errors: because we do NOT pass "EX0", ROOT includes the X uncertainties
    # by the "effective variance" method: each point's error becomes
    #     sigma_eff^2 = ey^2 + (f'(x) * ex)^2
    # which is re-evaluated as the parameters change. This is the standard way
    # to do a chi^2 fit when both axes carry errors. With all ex = 0 it reduces
    # to the ordinary weighted least-squares chi^2.
    # Points with ey = 0 (and ex = 0) get weight 1, i.e. an unweighted fit; the
    # reported chi2 is then in units of the (unknown) data variance.
    fit_ptr = graph.Fit(func, "SQR")      # a TFitResultPtr (a smart pointer)
    result = fit_ptr.Get()                # -> the TFitResult itself
    if not result:
        raise RuntimeError("ROOT returned no fit result (the fit could not be started)")

    status = int(result.Status())
    ndf = int(result.Ndf())
    chi2 = float(result.Chi2())

    params = [
        {
            "index": i,
            "name": func.GetParName(i),
            "value": float(func.GetParameter(i)),
            "error": float(func.GetParError(i)),
        }
        for i in range(npar)
    ]
    cov = [[float(result.CovMatrix(i, j)) for j in range(npar)] for i in range(npar)]

    # --- the picture -------------------------------------------------------
    # Draw the graph on a canvas in batch mode. Painting is what makes ROOT
    # create the title and the statistics box (fit parameters, chi2/ndf, prob),
    # so we call Update() before serialising. The fitted TF1 is already attached
    # to the graph by Fit(), so JSROOT will draw the curve on top of the points.
    plot = plot or {}
    canvas = ROOT.TCanvas("c1", "fit", 900, 600)
    if plot.get("grid", True):
        canvas.SetGrid()
    # Log axes are a property of the pad, not of the data. ROOT simply cannot
    # place x <= 0 (or y <= 0) points on a log axis; they are skipped, not an error.
    if plot.get("logx"):
        canvas.SetLogx(1)
    if plot.get("logy"):
        canvas.SetLogy(1)
    graph.Draw("AP")                  # A = draw axes, P = draw points/markers
    canvas.Update()

    # Store the curve as sampled points too (fSave). JSROOT can evaluate most
    # formulas itself, but for anything exotic it falls back to these values,
    # so the browser always shows ROOT's own evaluation of the fitted function.
    fitted = graph.GetListOfFunctions().FindObject("fit")
    if fitted:
        fitted.Save(xmin, xmax, 0, 0, 0, 0)

    def to_dict(obj):
        return json.loads(str(ROOT.TBufferJSON.ToJSON(obj)))

    out = {
        "status": status,                     # 0 = converged
        "converged": status == 0 and result.IsValid(),
        "status_message": STATUS_MESSAGES.get(status, f"Minuit status {status}"),
        "formula": formula,
        "range": [xmin, xmax],
        "n_points": int(n),
        "params": params,
        "chi2": chi2,
        "ndf": ndf,
        "chi2_ndf": (chi2 / ndf) if ndf > 0 else None,
        "prob": float(result.Prob()),          # p-value of chi2 for ndf degrees of freedom
        "covariance": cov,
        # ROOT objects serialised for JSROOT
        "canvas_json": to_dict(canvas),
        "graph_json": to_dict(graph),
        "func_json": to_dict(fitted) if fitted else None,
    }

    canvas.Close()
    return out
