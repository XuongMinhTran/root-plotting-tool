"""
simultaneous_fit.py — fit two or more XY datasets at once with shared parameters.

Every dataset keeps its own model, fit range, exclusions and data. Each
parameter of each model is mapped to one entry of a single *global* parameter
vector: a shared parameter (one entry used by several models), a local
parameter (an entry used by one model only) or a fixed value (an entry Minuit
never varies). The quantity minimized is the plain sum of the per-dataset chi^2
values, following ROOT's combinedFit.C tutorial: each dataset gets a
ROOT::Fit::Chi2Function built from its own ROOT::Fit::BinData, and a small C++
class (compiled once by Cling below) adds them up after routing the global
parameters to each model.

The per-dataset chi^2 objects are the very ones TGraphErrors::Fit uses
(FillData -> BinData -> FitUtil::EvaluateChi2), so X uncertainties enter through
the same effective-variance rule as in a single-dataset fit,
    sigma_i^2 = ey_i^2 + (f'(x_i) * ex_i)^2,
re-evaluated as the parameters change. simultaneous_test.py checks this
equivalence explicitly.

Degrees of freedom = points used in all datasets - free unique parameters.
The covariance matrix covers every unique parameter (rows and columns of fixed
values are zero).
"""

import json
import math

import numpy as np
import ROOT

import diagnostics
from fit import _safe_title, STATUS_MESSAGES

MAX_DATASETS = 8
MAX_POINTS = 100_000
MAX_PARAMETERS = 60

# Marker style and colour per dataset, in the same order as DATASET_COLORS in
# the frontend so the plot legend matches the dataset tabs.
STYLES = [
    (20, '#000000'), (21, '#d62728'), (22, '#1f5fbf'), (23, '#2a8f3c'),
    (33, '#8e44ad'), (34, '#e08a00'), (29, '#17a2b8'), (47, '#7f4f24'),
]

X_ERROR_NOTE = ("X uncertainties are included by ROOT's effective-variance method, "
                "sigma_i^2 = ey_i^2 + (f'(x_i) * ex_i)^2, the same rule as in a single-dataset fit.")

_DECLARED = ROOT.gInterpreter.Declare(r"""
#include "Math/IFunction.h"
#include "Math/WrappedMultiTF1.h"
#include "Fit/BinData.h"
#include "Fit/Chi2FCN.h"
#include "Fit/Fitter.h"
#include "HFitInterface.h"
#include <vector>
#include <cstddef>
namespace rootatron {
/// Sum of several chi-square functions that each read a slice of one global parameter vector.
class CombinedChi2 : public ROOT::Math::IMultiGenFunction {
public:
   explicit CombinedChi2(unsigned int npar) : fNPar(npar) {}
   void Add(const ROOT::Math::IMultiGenFunction *part, const std::vector<int> &index) {
      fParts.push_back(part);
      fIndex.push_back(index);
   }
   unsigned int NDim() const override { return fNPar; }
   ROOT::Math::IMultiGenFunction *Clone() const override { return new CombinedChi2(*this); }
   unsigned int Size() const { return fParts.size(); }
   /// chi-square of dataset k for the global parameters p
   double Part(unsigned int k, const double *p) const {
      const std::vector<int> &index = fIndex[k];
      std::vector<double> local(index.size());
      for (std::size_t i = 0; i < index.size(); ++i) local[i] = p[index[i]];
      return (*fParts[k])(local.data());
   }
private:
   double DoEval(const double *p) const override {
      double sum = 0;
      for (unsigned int k = 0; k < fParts.size(); ++k) sum += Part(k, p);
      return sum;
   }
   unsigned int fNPar;
   std::vector<const ROOT::Math::IMultiGenFunction *> fParts;
   std::vector<std::vector<int>> fIndex;
};
}
""")
if not _DECLARED:
    raise ImportError("ROOT could not compile the combined chi-square helper (see the server log).")


# ---------------------------------------------------------------- request parsing

def _finite(value, label, allow_blank=False):
    """A finite float, or None for a blank optional entry."""
    if value is None or (isinstance(value, str) and not value.strip()):
        if allow_blank:
            return None
        raise ValueError(f"{label}: enter a number.")
    try:
        f = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label}: {value!r} is not a number.")
    if not math.isfinite(f):
        raise ValueError(f"{label}: enter a finite number.")
    return f


def _column(raw, key, label, required=False):
    values = raw.get(key)
    if values is None or values == "":
        if required:
            raise ValueError(f"{label}: the {key.upper()} column is empty.")
        return np.zeros(0)
    if not isinstance(values, list):
        raise ValueError(f"{label}: column '{key}' must be a list of numbers.")
    if len(values) > MAX_POINTS:
        raise ValueError(f"{label}: column '{key}' has more than {MAX_POINTS} points.")
    out = []
    for i, v in enumerate(values):
        try:
            f = float(v)
        except (TypeError, ValueError):
            raise ValueError(f"{label}: column '{key}', entry {i + 1} ({v!r}) is not a number.")
        if not math.isfinite(f):
            raise ValueError(f"{label}: column '{key}', entry {i + 1} is not a finite number.")
        out.append(f)
    if required and not out:
        raise ValueError(f"{label}: the {key.upper()} column is empty.")
    return np.asarray(out, dtype=float)


def parse_request(payload, check_formula):
    """Validate the JSON body of POST /simultaneous-fit. Raises ValueError with a
    message meant for the person at the keyboard."""
    if not isinstance(payload, dict):
        raise ValueError("Request body must be a JSON object.")
    raw_sets = payload.get("datasets")
    if not isinstance(raw_sets, list) or len(raw_sets) < 2:
        raise ValueError("A simultaneous fit needs at least two datasets.")
    if len(raw_sets) > MAX_DATASETS:
        raise ValueError(f"Fit at most {MAX_DATASETS} datasets together.")
    parameters = payload.get("parameters") if isinstance(payload.get("parameters"), dict) else {}
    shared_raw = parameters.get("shared") or []
    mapping_raw = parameters.get("mapping") or []
    if not isinstance(shared_raw, list) or not isinstance(mapping_raw, list) or len(mapping_raw) != len(raw_sets):
        raise ValueError("Each dataset needs a parameter assignment list. Reopen the simultaneous fit dialog and try again.")

    shared = []
    for k, s in enumerate(shared_raw):
        if not isinstance(s, dict):
            raise ValueError("Shared parameters must be objects with a name and an initial guess.")
        name = str(s.get("name") or "").strip() or f"shared{k + 1}"
        guess = _finite(s.get("guess"), f"Shared parameter {name}: initial guess", allow_blank=True)
        lo = _finite(s.get("min"), f"Shared parameter {name}: lower limit", allow_blank=True)
        hi = _finite(s.get("max"), f"Shared parameter {name}: upper limit", allow_blank=True)
        if lo is not None and hi is not None and not lo < hi:
            raise ValueError(f"Shared parameter {name}: the lower limit must be smaller than the upper limit.")
        if guess is not None and ((lo is not None and guess < lo) or (hi is not None and guess > hi)):
            raise ValueError(f"Shared parameter {name}: the initial guess must lie within its limits.")
        shared.append(dict(name=name, guess=guess, min=lo, max=hi))
    if len({s["name"] for s in shared}) != len(shared):
        raise ValueError("Shared parameter names must be unique.")

    members = []
    for i, raw in enumerate(raw_sets):
        if not isinstance(raw, dict):
            raise ValueError("Each dataset must be a JSON object.")
        name = str(raw.get("name") or f"Dataset {i + 1}")
        x = _column(raw, "x", name, required=True)
        y = _column(raw, "y", name, required=True)
        if len(x) != len(y):
            raise ValueError(f"{name}: X has {len(x)} points but Y has {len(y)}.")
        errors = {}
        for key, axis in (("ex", "X"), ("ey", "Y")):
            e = _column(raw, key, name)
            if len(e) == 1:
                e = np.full(len(x), e[0])
            if len(e) not in (0, len(x)):
                raise ValueError(f"{name}: the {axis} error column has {len(e)} values for {len(x)} points. "
                                 f"Enter one value for the whole axis, {len(x)} values for individual points, or leave it blank.")
            if (e < 0).any():
                raise ValueError(f"{name}: {axis} errors describe a size, so use zero or a positive number.")
            errors[key] = e if len(e) else np.zeros(len(x))
        formula = str(raw.get("formula") or "").strip()
        ok, message = check_formula(formula)
        if not ok:
            raise ValueError(f"{name}: the fitting service could not read this function: {message}")
        names = raw.get("param_names") or []
        if isinstance(names, str):
            names = [s.strip() for s in names.split(",")]
        if not isinstance(names, list):
            raise ValueError(f"{name}: parameter names must be a list.")
        names = [str(n).strip() for n in names]
        x_range = raw.get("x_range")
        if x_range in (None, "", []):
            x_range = None
        else:
            try:
                x_range = (float(x_range[0]), float(x_range[1]))
            except (TypeError, ValueError, IndexError):
                raise ValueError(f"{name}: x_range must be [xmin, xmax].")
            if not (math.isfinite(x_range[0]) and math.isfinite(x_range[1]) and x_range[0] < x_range[1]):
                raise ValueError(f"{name}: fit range: xmin must be smaller than xmax.")
        excluded = raw.get("excluded_points") or []
        if not isinstance(excluded, list) or len(excluded) > MAX_POINTS:
            raise ValueError(f"{name}: excluded points must be a list.")
        clean = []
        for p in excluded:
            if not isinstance(p, dict):
                raise ValueError(f"{name}: excluded points must be objects with x and y.")
            clean.append(dict(x=_finite(p.get("x"), f"{name}: excluded point x"), y=_finite(p.get("y"), f"{name}: excluded point y")))
        assignment = mapping_raw[i]
        if not isinstance(assignment, list) or not all(isinstance(a, dict) for a in assignment):
            raise ValueError(f"{name}: the parameter assignment must be a list of objects.")
        members.append(dict(name=name, x=x, y=y, ex=errors["ex"], ey=errors["ey"], formula=formula,
                            param_names=names, x_range=x_range, excluded=clean, assignment=assignment))

    plot = payload.get("plot") if isinstance(payload.get("plot"), dict) else {}
    return dict(name=str(payload.get("name") or "Simultaneous fit"), shared=shared, members=members, plot=plot,
                title=str(payload.get("title") or ""), x_title=str(payload.get("x_title") or ""),
                y_title=str(payload.get("y_title") or ""))


# ---------------------------------------------------------------- the fit

def fill_bin_data(data, graph, x, y, ex, ey, xmin, xmax):
    """Fill a BinData from a graph the way TGraphErrors::Fit does: ROOT::Fit::FillData
    decides the error type (coordinate errors when any ex > 0, unit weights when no
    point has an uncertainty) and skips points with a zero Y error otherwise. If the
    binding to FillData is unavailable in this ROOT build, the same rules are applied
    by hand."""
    try:
        ROOT.Fit.FillData(data, graph)
        return
    except (AttributeError, TypeError):
        pass
    has_x = bool((ex > 0).any())
    kind = ROOT.Fit.BinData.kCoordError if has_x else (ROOT.Fit.BinData.kNoError if not (ey > 0).any() else ROOT.Fit.BinData.kValueError)
    data.Initialize(len(x), 1, kind)
    for xi, yi, exi, eyi in zip(x, y, ex, ey):
        if xi < xmin or xi > xmax:
            continue
        if kind == ROOT.Fit.BinData.kNoError:
            data.Add(float(xi), float(yi))
        elif eyi <= 0:
            continue
        elif kind == ROOT.Fit.BinData.kValueError:
            data.Add(float(xi), float(yi), float(eyi))
        else:
            data.Add(float(xi), float(yi), float(exi), float(eyi))


def run_simultaneous(spec):
    """Run the combined fit described by parse_request(). Returns a JSON-serializable dict."""
    plot = spec["plot"]
    configs = diagnostics.configurations(plot)
    if plot.get("confidence_level") not in (None, "", 0, "0"):
        raise ValueError("Confidence bands are not available for simultaneous fits. Set the confidence band to None and fit again.")
    shared, members = spec["shared"], spec["members"]

    # --- the global parameter table: shared parameters first, then each dataset's own entries
    params = []
    for s in shared:
        params.append(dict(name=s["name"], kind="shared", dataset=None, dataset_name=None, local_index=None,
                           guess=s["guess"], min=s["min"], max=s["max"], fixed=False, used_by=[]))
    keep = []                    # ROOT objects that must outlive the fit (Chi2Function keeps raw references)
    chi2_parts, index_maps, funcs, graphs, datas = [], [], [], [], []
    total_points = 0
    any_x_errors = False
    for i, m in enumerate(members):
        name = m["name"]
        x, y, ex, ey = m["x"], m["y"], m["ex"], m["ey"]
        n = len(x)
        if m["x_range"] is None:
            xmin, xmax = float(x.min()), float(x.max())
        else:
            xmin, xmax = m["x_range"]
        if xmin == xmax:
            raise ValueError(f"{name}: all x values are identical, nothing to fit against.")
        m["range"] = (xmin, xmax)

        graph = ROOT.TGraphErrors(n, x, y, ex, ey)
        graph.SetName(f"data_{i}")
        graph.SetTitle(_safe_title(name))
        func = ROOT.TF1(f"fit_{i}", m["formula"], xmin, xmax)
        if not func.IsValid():
            raise ValueError(f"{name}: ROOT could not parse the formula {m['formula']!r}")
        func.SetNpx(400)
        npar = func.GetNpar()
        assignment = m["assignment"]
        if len(assignment) != npar:
            raise ValueError(f"{name}: the model has {npar} parameter(s) but {len(assignment)} assignment(s) were given. "
                             "Reopen the simultaneous fit dialog to refresh its parameter table.")
        index = []
        for j, a in enumerate(assignment):
            pname = m["param_names"][j] if j < len(m["param_names"]) and m["param_names"][j] else func.GetParName(j)
            func.SetParName(j, str(pname))
            kind = a.get("kind")
            label = f"{name}, parameter {pname}"
            if kind == "shared":
                ref = a.get("ref")
                if not isinstance(ref, int) or isinstance(ref, bool) or not 0 <= ref < len(shared):
                    raise ValueError(f"{label}: choose which shared parameter it uses.")
                params[ref]["used_by"].append(i)
                index.append(ref)
            elif kind == "fixed":
                value = _finite(a.get("value"), f"{label}: fixed value")
                params.append(dict(name=str(pname), kind="fixed", dataset=i, dataset_name=name, local_index=j,
                                   guess=value, min=None, max=None, fixed=True, used_by=[i]))
                index.append(len(params) - 1)
            elif kind == "local":
                guess = _finite(a.get("guess"), f"{label}: initial guess", allow_blank=True)
                params.append(dict(name=str(pname), kind="local", dataset=i, dataset_name=name, local_index=j,
                                   guess=guess, min=None, max=None, fixed=False, used_by=[i]))
                index.append(len(params) - 1)
            else:
                raise ValueError(f"{label}: choose shared, this dataset only, or fixed.")
        if len(params) > MAX_PARAMETERS:
            raise ValueError(f"A simultaneous fit can have at most {MAX_PARAMETERS} parameters in total.")

        # --- the data, exactly as TGraphErrors::Fit would prepare it (range, error type, zero-error rules)
        options = ROOT.Fit.DataOptions()
        data_range = ROOT.Fit.DataRange()
        data_range.SetRange(xmin, xmax)
        data = ROOT.Fit.BinData(options, data_range)
        fill_bin_data(data, graph, x, y, ex, ey, xmin, xmax)
        used = int(data.Size())
        if used < 2:
            if (ex > 0).any() and not (ey > 0).any():
                raise ValueError(f"{name}: ROOT skips points that have an X uncertainty but no Y uncertainty. "
                                 "Enter Y uncertainties for this dataset, or remove its X uncertainties.")
            raise ValueError(f"{name}: only {used} point(s) with a usable uncertainty fall inside the fit range [{xmin:g}, {xmax:g}]. "
                             "Widen the range, include more measurements, or check the uncertainty columns.")
        has_x_errors = bool((ex > 0).any())
        if has_x_errors and int(data.GetErrorType()) != int(ROOT.Fit.BinData.kCoordError):
            raise ValueError(f"{name}: ROOT did not accept the X uncertainties of this dataset, so the simultaneous "
                             "fit was not run. Remove the X uncertainties, or fit this dataset on its own.")
        any_x_errors = any_x_errors or has_x_errors
        m["weighted"] = bool((ey > 0).any() or has_x_errors)
        wrapped = ROOT.Math.WrappedMultiTF1(func, 1)
        part = ROOT.Fit.Chi2Function(data, wrapped)
        keep += [graph, func, options, data_range, data, wrapped, part]
        chi2_parts.append(part)
        index_maps.append(index)
        funcs.append(func)
        graphs.append(graph)
        datas.append(data)
        m["n_used"] = used
        m["has_x_errors"] = has_x_errors
        total_points += used

    for p in params[:len(shared)]:
        if not p["used_by"]:
            raise ValueError(f"Shared parameter {p['name']} is not used by any dataset. Assign it to at least one parameter, or remove it.")
    npar = len(params)
    nfree = sum(1 for p in params if not p["fixed"])
    if nfree == 0:
        raise ValueError("Every parameter is fixed, so there is nothing to fit.")
    if total_points < nfree:
        raise ValueError(f"The datasets provide {total_points} usable points for {nfree} free parameters. Include more measurements or fix some parameters.")

    # --- the combined chi-square and the fit
    fcn = ROOT.rootatron.CombinedChi2(npar)
    for part, index in zip(chi2_parts, index_maps):
        vec = ROOT.std.vector("int")()
        for g in index:
            vec.push_back(int(g))
        fcn.Add(part, vec)
        keep.append(vec)
    start = np.array([p["guess"] if p["guess"] is not None else 0.0 for p in params], dtype=np.float64)
    fitter = ROOT.Fit.Fitter()
    config = fitter.Config()
    config.SetParamsSettings(npar, start)
    for i, p in enumerate(params):
        settings = config.ParSettings(i)
        settings.SetName(p["name"])
        if p["fixed"]:
            settings.Fix()
        elif p["min"] is not None and p["max"] is not None:
            settings.SetLimits(p["min"], p["max"])
        elif p["min"] is not None:
            settings.SetLowerLimit(p["min"])
        elif p["max"] is not None:
            settings.SetUpperLimit(p["max"])
    config.MinimizerOptions().SetPrintLevel(-1)
    # fitType 1 = least squares (error definition 1, NDF = points - free parameters).
    # The parameters are passed as nullptr on purpose: a non-null pointer would make
    # the fitter rebuild its parameter settings and forget the fixed values and limits.
    fitter.FitFCN(fcn, ROOT.nullptr, int(total_points), 1)
    result = fitter.Result()

    status = int(result.Status())
    valid = bool(result.IsValid())
    values = [float(result.Parameter(i)) for i in range(npar)]
    errors = [0.0 if params[i]["fixed"] else float(result.ParError(i)) for i in range(npar)]
    cov = [[0.0 if (params[i]["fixed"] or params[j]["fixed"]) else float(result.CovMatrix(i, j)) for j in range(npar)] for i in range(npar)]
    values_array = np.asarray(values, dtype=np.float64)
    # The total chi2 is the combined FCN at the solution (identical to Minuit's minimum
    # value); computing it here does not depend on how FitResult labels a generic FCN.
    part_chi2s = [float(fcn.Part(k, values_array)) for k in range(len(members))]
    chi2 = float(sum(part_chi2s))
    ndf = max(0, int(total_points) - int(nfree))
    prob = float(ROOT.TMath.Prob(chi2, ndf)) if ndf > 0 and math.isfinite(chi2) else None

    # --- per-dataset results, fitted functions, diagnostics
    plot_notes = []
    if any_x_errors:
        plot_notes.append(X_ERROR_NOTE)
    for m in members:
        if not m["weighted"]:
            plot_notes.append(f"{m['name']} has no uncertainties: each of its points enters chi-square with weight 1, "
                              "so its chi-square share is not on the same scale as datasets with uncertainties.")
    for p in params[:len(shared)]:
        if len(set(p["used_by"])) == 1:
            plot_notes.append(f"Shared parameter {p['name']} is used by one dataset only ({members[p['used_by'][0]]['name']}), so it acts like a local parameter.")
    merged, order = {}, [cfg["kind"] for cfg in configs]
    out_sets = []
    for i, m in enumerate(members):
        func, index = funcs[i], index_maps[i]
        for j, g in enumerate(index):
            func.SetParameter(j, values[g])
            func.SetParError(j, errors[g])
        part_chi2 = part_chi2s[i]
        xmin, xmax = m["range"]
        panels, notes, _ = diagnostics.calculate(configs, m["x"], m["y"], m["ex"], m["ey"], func, xmin, xmax)
        plot_notes += [f"{m['name']}: {note}" for note in notes]
        marker, colour = STYLES[i % len(STYLES)]
        for panel in panels:
            kind = panel["kind"]
            if kind not in merged:
                merged[kind] = {key: panel[key] for key in ("kind", "title", "x_title", "y_title", "height", "bins", "y_min", "y_max",
                                                            "scope", "grid", "reference", "errors", "baseline")}
                merged[kind].update(series=[], n_points=0, skipped=0)
            merged[kind]["series"].append(dict(name=m["name"], color=colour, marker=marker, x=panel["x"], values=panel["values"],
                                               x_errors=panel["x_errors"], errors_values=panel["errors_values"], n_points=panel["n_points"]))
            merged[kind]["n_points"] += panel["n_points"]
            merged[kind]["skipped"] += panel["skipped"]
        out_sets.append(dict(
            index=i, name=m["name"], formula=m["formula"], range=[xmin, xmax], n_points=int(m["n_used"]), n_total=int(len(m["x"])),
            n_excluded=len(m["excluded"]), chi2=part_chi2, x_errors=bool(m["has_x_errors"]), weighted=bool(m["weighted"]),
            color=colour, marker=marker,
            params=[dict(local_index=j, index=int(g), name=params[g]["name"], kind=params[g]["kind"], value=values[g], error=errors[g], fixed=params[g]["fixed"])
                    for j, g in enumerate(index)],
        ))
    panels = [merged[kind] for kind in order if kind in merged]
    for panel in panels:
        if panel["kind"] == "histogram":
            everything = np.concatenate([np.asarray(s["values"], dtype=float) for s in panel["series"]])
            lo, hi = float(everything.min()), float(everything.max())
            padding = (hi - lo) * .05 if hi > lo else max(abs(lo) * .05, .5)
            edges = np.linspace(lo - padding, hi + padding, panel["bins"] + 1)
            for s in panel["series"]:
                counts, _ = np.histogram(np.asarray(s["values"], dtype=float), bins=edges)
                s["counts"] = counts.tolist()
            panel["edges"] = edges.tolist()

    out = {
        "analysis_type": "simultaneous",
        "name": spec["name"],
        "status": status,
        "converged": status == 0 and valid,
        "status_message": STATUS_MESSAGES.get(status, f"Minuit status {status}"),
        "n_datasets": len(members),
        "n_points": int(total_points),
        "n_free": int(nfree),
        "params": [dict(index=i, name=p["name"], label=p["name"] if p["kind"] == "shared" else f"{p['name']} ({p['dataset_name']})",
                        kind=p["kind"], dataset=p["dataset"], dataset_name=p["dataset_name"],
                        local_index=p["local_index"], value=values[i], error=errors[i], fixed=p["fixed"],
                        limits=[p["min"], p["max"]] if (p["min"] is not None or p["max"] is not None) else None,
                        used_by=sorted(set(p["used_by"])))
                   for i, p in enumerate(params)],
        "covariance": cov,
        "covariance_status": int(result.CovMatrixStatus()),
        "chi2": chi2,
        "ndf": ndf,
        "chi2_ndf": (chi2 / ndf) if ndf > 0 else None,
        "prob": prob,
        "datasets": out_sets,
        "x_error_note": X_ERROR_NOTE if any_x_errors else None,
        "residuals": {"kind": "none"},
        "diagnostics": panels,
        "plot_notes": plot_notes,
        # keep the same top-level keys as /fit so the frontend's plot code needs no special case
        "formula": "; ".join(f"{m['name']}: {m['formula']}" for m in members),
        "range": [min(m["range"][0] for m in members), max(m["range"][1] for m in members)],
        "confidence_band": None,
        **render_combined_plot(members, graphs, funcs, panels, plot, spec["title"], spec["x_title"], spec["y_title"]),
    }
    return out


# ---------------------------------------------------------------- drawing

def render_combined_plot(members, graphs, funcs, panels, plot, title, x_title, y_title):
    keep = []
    main_height = 500
    total_height = main_height + sum(p["height"] for p in panels) if panels else 600
    canvas = ROOT.TCanvas("c1", "simultaneous fit", 900, total_height)
    colours = [ROOT.TColor.GetColor(STYLES[i % len(STYLES)][1]) for i in range(len(members))]
    markers = [STYLES[i % len(STYLES)][0] for i in range(len(members))]

    def style_pad(pad, logx=False, logy=False, grid=True):
        pad.SetGrid(int(grid), int(grid))
        pad.SetLogx(int(bool(logx)))
        pad.SetLogy(int(bool(logy)))

    def draw_main():
        multi = ROOT.TMultiGraph("data", f"{_safe_title(title)};{_safe_title(x_title)};{_safe_title(y_title)}")
        all_x, all_y = [], []
        for i, (m, graph) in enumerate(zip(members, graphs)):
            graph.SetMarkerStyle(markers[i])
            graph.SetMarkerSize(0.9)
            graph.SetMarkerColor(colours[i])
            graph.SetLineColor(colours[i])
            multi.Add(graph, "P")
            all_x += list(m["x"]) + [p["x"] for p in m["excluded"]]
            all_y += list(m["y"]) + [p["y"] for p in m["excluded"]]
        dx, dy = max(all_x) - min(all_x), max(all_y) - min(all_y)
        multi.SetMinimum(min(all_y) - .1 * (dy or 1))
        multi.SetMaximum(max(all_y) + .1 * (dy or 1))
        multi.Draw("AP")
        multi.GetXaxis().SetLimits(min(all_x) - .05 * (dx or 1), max(all_x) + .05 * (dx or 1))
        keep.append(multi)
        for i, (m, func) in enumerate(zip(members, funcs)):
            func.SetLineColor(colours[i])
            func.SetLineWidth(2)
            func.Draw("SAME")
        for i, m in enumerate(members):
            if not m["excluded"]:
                continue
            xx = np.asarray([p["x"] for p in m["excluded"]], dtype=float)
            yy = np.asarray([p["y"] for p in m["excluded"]], dtype=float)
            omitted = ROOT.TGraph(len(xx), xx, yy)
            omitted.SetName(f"excluded_points_{i}")
            omitted.SetTitle(f"{_safe_title(m['name'])}: excluded measurements")
            omitted.SetMarkerStyle(24)
            omitted.SetMarkerColor(ROOT.kGray + 1)
            omitted.Draw("P SAME")
            keep.append(omitted)
        rows = len(members)
        legend = ROOT.TLegend(0.62, max(0.55, 0.88 - 0.045 * rows), 0.89, 0.88)
        legend.SetName("legend")
        legend.SetBorderSize(1)
        legend.SetTextSize(0.028)
        for m, graph in zip(members, graphs):
            legend.AddEntry(graph, _safe_title(m["name"]), "lp")
        legend.Draw()
        keep.append(legend)
        return multi

    if not panels:
        style_pad(canvas, plot.get("logx"), plot.get("logy"), plot.get("grid", True))
        draw_main()
    else:
        split = 1.0 - main_height / total_height
        main_pad = ROOT.TPad("main_plot", "Fit", 0, split, 1, 1)
        main_pad.SetLeftMargin(.14)
        main_pad.SetBottomMargin(.14)
        style_pad(main_pad, plot.get("logx"), plot.get("logy"), plot.get("grid", True))
        main_pad.Draw()
        main_pad.cd()
        frame = draw_main()
        keep.append(main_pad)
        xlow, xhigh = frame.GetXaxis().GetXmin(), frame.GetXaxis().GetXmax()
        top = split
        for panel in panels:
            canvas.cd()
            bottom = top - panel["height"] / total_height
            pad = ROOT.TPad("panel_" + panel["kind"], panel["title"], 0, max(0, bottom), 1, top)
            pad.SetLeftMargin(.14)
            pad.SetRightMargin(.06)
            pad.SetTopMargin(.16)
            pad.SetBottomMargin(.23)
            histogram = panel["kind"] == "histogram"
            style_pad(pad, plot.get("logx") and not histogram, False, panel["grid"])
            pad.Draw()
            pad.cd()
            xtitle = panel["x_title"] or ("data - fit" if histogram else x_title)
            obj_title = f";{_safe_title(xtitle)};{_safe_title(panel['y_title'])}"
            drawn = []   # one ROOT object per dataset, for the panel legend
            if histogram:
                edges = panel["edges"]
                peak = max(max(s["counts"]) for s in panel["series"])
                auto_low, auto_high = 0.0, max(1, peak * 1.15)
                obj = None
                for k, s in enumerate(panel["series"]):
                    hist = ROOT.TH1D(f"diagnostic_{panel['kind']}_{k}", obj_title, len(edges) - 1, edges[0], edges[-1])
                    hist.SetDirectory(0)
                    hist.SetStats(False)
                    for b, count in enumerate(s["counts"], 1):
                        hist.SetBinContent(b, count)
                    hist.SetEntries(s["n_points"])
                    colour = ROOT.TColor.GetColor(s["color"])
                    hist.SetLineColor(colour)
                    hist.SetLineWidth(2)
                    hist.Draw("HIST" if obj is None else "HIST SAME")
                    if obj is None:
                        obj = hist
                    keep.append(hist)
                    drawn.append(hist)
                low, high = edges[0], edges[-1]
            else:
                obj = ROOT.TMultiGraph(f"diagnostic_{panel['kind']}", obj_title)
                lo, hi = math.inf, -math.inf
                for s in panel["series"]:
                    px = np.asarray(s["x"], dtype=float)
                    py = np.asarray(s["values"], dtype=float)
                    pex = np.asarray(s["x_errors"], dtype=float) if panel["errors"] else np.zeros(len(px))
                    pey = np.asarray(s["errors_values"], dtype=float) if panel["errors"] else np.zeros(len(px))
                    series = ROOT.TGraphErrors(len(px), px, py, pex, pey)
                    series.SetName(f"diagnostic_{panel['kind']}_{len(keep)}")
                    series.SetTitle(_safe_title(s["name"]))
                    colour = ROOT.TColor.GetColor(s["color"])
                    series.SetMarkerStyle(s["marker"])
                    series.SetMarkerSize(.65)
                    series.SetMarkerColor(colour)
                    series.SetLineColor(colour)
                    obj.Add(series, "P")
                    keep.append(series)
                    drawn.append(series)
                    lo, hi = min(lo, float(np.min(py - pey))), max(hi, float(np.max(py + pey)))
                if panel["reference"]:
                    lo, hi = min(lo, panel["baseline"]), max(hi, panel["baseline"])
                margin = (hi - lo) * .12 if hi > lo else max(abs(lo) * .1, 1)
                auto_low, auto_high = lo - margin, hi + margin
                obj.SetMinimum(auto_low)
                obj.SetMaximum(auto_high)
                obj.Draw("AP")
                obj.GetXaxis().SetLimits(xlow, xhigh)
                low, high = xlow, xhigh
            lower = panel["y_min"] if panel["y_min"] is not None else auto_low
            upper = panel["y_max"] if panel["y_max"] is not None else auto_high
            if lower >= upper:
                if panel["y_max"] is None:
                    upper = lower + max(abs(lower) * .1, 1)
                else:
                    lower = upper - max(abs(upper) * .1, 1)
            obj.SetMinimum(lower)
            obj.SetMaximum(upper)
            for axis in (obj.GetXaxis(), obj.GetYaxis()):
                axis.SetLabelSize(16 / panel["height"])
                axis.SetTitleSize(18 / panel["height"])
            obj.GetXaxis().SetTitleOffset(1.0)
            obj.GetYaxis().SetTitleOffset(.85)
            obj.GetYaxis().SetNdivisions(505)
            heading = ROOT.TLatex(.14, .91, _safe_title(panel["title"]))
            heading.SetNDC(True)
            heading.SetTextFont(42)
            heading.SetTextSize(18 / panel["height"])
            heading.Draw()
            # Every panel names its datasets, in the same colours as the main legend.
            panel_legend = ROOT.TLegend(0.70, max(0.30, 0.82 - 0.09 * len(drawn)), 0.94, 0.82)
            panel_legend.SetName("legend_" + panel["kind"])
            panel_legend.SetBorderSize(1)
            panel_legend.SetTextSize(14 / panel["height"])
            for series_obj, s in zip(drawn, panel["series"]):
                panel_legend.AddEntry(series_obj, _safe_title(s["name"]), "l" if histogram else "p")
            panel_legend.Draw()
            keep.append(panel_legend)
            if panel["reference"]:
                if histogram:
                    line = ROOT.TLine(0, lower, 0, upper)
                    visible = low <= 0 <= high
                else:
                    line = ROOT.TLine(low, panel["baseline"], high, panel["baseline"])
                    visible = ((panel["y_min"] is None or panel["y_min"] <= panel["baseline"])
                               and (panel["y_max"] is None or panel["y_max"] >= panel["baseline"]))
                if visible:
                    line.SetLineColor(ROOT.kRed)
                    line.SetLineStyle(2)
                    line.Draw()
                    keep.append(line)
            keep += [pad, obj, heading]
            top = bottom
        canvas.cd()

    canvas.Update()
    for m, func in zip(members, funcs):
        func.Save(m["range"][0], m["range"][1], 0, 0, 0, 0)

    def to_dict(obj):
        return json.loads(str(ROOT.TBufferJSON.ToJSON(obj)))

    out = {
        "plot_height": total_height if panels else None,
        "canvas_json": to_dict(canvas),
        "graph_json": None,
        "func_json": None,
    }
    canvas.Close()
    return out
