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
import diagnostics

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
    ex, ey      : one error for the whole axis, a list per point, or None/[] (zero)
    formula     : TFormula string ("[0]*x+[1]") or named function ("gaus", "pol2", ...)
    par_names   : list of str, may be shorter than the number of parameters
    par_guesses : list of float (or None entries), may be shorter than the number of parameters
    x_range     : (xmin, xmax) or None -> use the data range
    title, x_title, y_title : plot labels
    plot        : dict of drawing options: {"logx": bool, "logy": bool, "grid": bool,
                  "diagnostics": list of per-panel settings; legacy "residuals" is also accepted}

    Returns a plain dict (JSON-serialisable). Raises ValueError for bad input.
    """
    plot = plot or {}
    configs = diagnostics.configurations(plot)
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    n = len(x)
    if n == 0 or len(y) != n:
        raise ValueError("x and y must be non-empty and have the same number of points")

    ex = np.zeros(n) if ex is None or len(ex) == 0 else np.asarray(ex, dtype=float)
    ey = np.zeros(n) if ey is None or len(ey) == 0 else np.asarray(ey, dtype=float)
    if len(ex) == 1:
        ex = np.full(n, ex[0])
    if len(ey) == 1:
        ey = np.full(n, ey[0])
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

    # --- residuals ---------------------------------------------------------
    # residual_i = y_i - f(x_i), with the fitted parameters. Its error bar is the
    # same sigma that entered chi2: sigma_eff^2 = ey^2 + (f'(x) * ex)^2, so a
    # point that sits "1 error bar" from zero here contributed 1 to chi2.
    # "pull" = residual / sigma_eff: for a good fit the pulls scatter like a
    # standard normal (about 2/3 within +-1, hardly any beyond +-3). A trend in
    # the residuals (a bow, a wave) is the clearest sign of a wrong model.
    fitted = graph.GetListOfFunctions().FindObject("fit")
    if not fitted:
        raise RuntimeError("ROOT did not attach the fitted function to the graph")
    panels, plot_notes, residuals = diagnostics.calculate(configs, x, y, ex, ey, fitted, xmin, xmax)

    # Give each selected diagnostic its own pad and physical height. The main
    # fit remains readable even when all optional panels are selected.
    keep = []
    main_height = 500
    total_height = main_height + sum(p['height'] for p in panels) if panels else 600
    canvas = ROOT.TCanvas("c1", "fit", 900, total_height)

    def style_pad(pad, logx=False, logy=False, grid=True):
        pad.SetGrid(int(grid), int(grid))
        pad.SetLogx(int(bool(logx)))
        pad.SetLogy(int(bool(logy)))

    if not panels:
        style_pad(canvas, plot.get('logx'), plot.get('logy'), plot.get('grid', True))
        graph.Draw("AP")
    else:
        split = 1.0 - main_height / total_height
        main_pad = ROOT.TPad('main_plot', 'Fit', 0, split, 1, 1)
        main_pad.SetLeftMargin(.14)
        main_pad.SetBottomMargin(.14)
        style_pad(main_pad, plot.get('logx'), plot.get('logy'), plot.get('grid', True))
        main_pad.Draw()
        main_pad.cd()
        graph.Draw('AP')
        keep.append(main_pad)
        xlow, xhigh = graph.GetXaxis().GetXmin(), graph.GetXaxis().GetXmax()
        top = split
        for panel in panels:
            canvas.cd()
            bottom = top - panel['height'] / total_height
            pad = ROOT.TPad('panel_' + panel['kind'], panel['title'], 0, max(0, bottom), 1, top)
            pad.SetLeftMargin(.14)
            pad.SetRightMargin(.06)
            pad.SetTopMargin(.16)
            pad.SetBottomMargin(.23)
            histogram = panel['kind'] == 'histogram'
            style_pad(pad, plot.get('logx') and not histogram, False, panel['grid'])
            pad.Draw()
            pad.cd()
            xtitle = panel['x_title'] or ('data - fit' if histogram else x_title)
            obj_title = f";{_safe_title(xtitle)};{_safe_title(panel['y_title'])}"
            if histogram:
                obj = ROOT.TH1D('diagnostic_' + panel['kind'], obj_title, panel['bins'], panel['edges'][0], panel['edges'][-1])
                obj.SetDirectory(0)
                obj.SetStats(False)
                for i, count in enumerate(panel['counts'], 1):
                    obj.SetBinContent(i, count)
                obj.SetEntries(panel['n_points'])
                obj.SetLineColor(ROOT.kBlue + 1)
                obj.SetLineWidth(2)
                auto_low, auto_high = 0.0, max(1, max(panel['counts']) * 1.15)
                obj.Draw('HIST')
                low, high = panel['edges'][0], panel['edges'][-1]
            else:
                px = np.asarray(panel['x'], dtype=float)
                py = np.asarray(panel['values'], dtype=float)
                pex = np.asarray(panel['x_errors'], dtype=float) if panel['errors'] else np.zeros(len(px))
                pey = np.asarray(panel['errors_values'], dtype=float) if panel['errors'] else np.zeros(len(px))
                obj = ROOT.TGraphErrors(len(px), px, py, pex, pey)
                obj.SetName('diagnostic_' + panel['kind'])
                obj.SetTitle(obj_title)
                obj.SetMarkerStyle(20)
                obj.SetMarkerSize(.65)
                # Include the reference line in the automatic Y range.
                lo, hi = float(np.min(py-pey)), float(np.max(py+pey))
                if panel['reference']:
                    lo, hi = min(lo, panel['baseline']), max(hi, panel['baseline'])
                margin = (hi-lo)*.12 if hi > lo else max(abs(lo)*.1, 1)
                auto_low, auto_high = lo-margin, hi+margin
                obj.SetMinimum(auto_low)
                obj.SetMaximum(auto_high)
                obj.Draw('AP')
                obj.GetXaxis().SetLimits(xlow, xhigh)
                low, high = xlow, xhigh
            lower = panel['y_min'] if panel['y_min'] is not None else auto_low
            upper = panel['y_max'] if panel['y_max'] is not None else auto_high
            if lower >= upper:
                if panel['y_max'] is None:
                    upper = lower + max(abs(lower) * .1, 1)
                else:
                    lower = upper - max(abs(upper) * .1, 1)
            obj.SetMinimum(lower)
            obj.SetMaximum(upper)
            for axis in (obj.GetXaxis(), obj.GetYaxis()):
                axis.SetLabelSize(16 / panel['height'])
                axis.SetTitleSize(18 / panel['height'])
            obj.GetXaxis().SetTitleOffset(1.0)
            obj.GetYaxis().SetTitleOffset(.85)
            obj.GetYaxis().SetNdivisions(505)
            # Explicit pad title keeps each panel's custom name legible.
            heading = ROOT.TLatex(.14, .91, _safe_title(panel['title']))
            heading.SetNDC(True)
            heading.SetTextFont(42)
            heading.SetTextSize(18 / panel['height'])
            heading.Draw()
            if panel['reference']:
                if histogram:
                    line = ROOT.TLine(0, lower, 0, upper)
                    visible = low <= 0 <= high
                else:
                    line = ROOT.TLine(low, panel['baseline'], high, panel['baseline'])
                    visible = (panel['y_min'] is None or panel['y_min'] <= panel['baseline']) and (panel['y_max'] is None or panel['y_max'] >= panel['baseline'])
                if visible:
                    line.SetLineColor(ROOT.kRed)
                    line.SetLineStyle(2)
                    line.Draw()
                    keep.append(line)
            keep += [pad, obj, heading]
            top = bottom
        canvas.cd()

    canvas.Update()

    # Store the curve as sampled points too (fSave). JSROOT can evaluate most
    # formulas itself, but for anything exotic it falls back to these values,
    # so the browser always shows ROOT's own evaluation of the fitted function.
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
        "residuals": residuals,
        "diagnostics": panels,
        "plot_notes": plot_notes,
        "plot_height": total_height if panels else None,
        # ROOT objects serialised for JSROOT
        "canvas_json": to_dict(canvas),
        "graph_json": to_dict(graph),
        "func_json": to_dict(fitted) if fitted else None,
    }

    canvas.Close()
    del keep
    return out
