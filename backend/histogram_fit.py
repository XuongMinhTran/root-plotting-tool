"""One-dimensional count histograms; independent of the XY fitting path."""
import math
from array import array

import numpy as np
import ROOT

import diagnostics
from fit import render_fit_plot, _safe_title, STATUS_MESSAGES, confidence_band

MAX_BINS = 2000
MAX_SAMPLES = 100_000


def numbers(data, key, required=False):
    raw = data.get(key, [])
    if not isinstance(raw, list) or len(raw) > MAX_SAMPLES:
        raise ValueError(f'{key}: enter a list of at most {MAX_SAMPLES} numbers.')
    try:
        result = np.asarray(raw, dtype=float)
        if result.ndim != 1 or not np.isfinite(result).all():
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError(f'{key}: each entry needs a finite number.')
    if required and not len(result):
        raise ValueError(f'Enter {key} before making the histogram.')
    return result


def prepare(data):
    if not isinstance(data, dict):
        raise ValueError('Enter measurements or bin edges and counts for the histogram.')
    source = data.get('source', 'samples')
    edges = numbers(data, 'edges')
    underflow = overflow = 0
    if source == 'samples':
        samples = numbers(data, 'samples', True)
        if not len(edges):
            bounds = data.get('range')
            if bounds is None:
                lo, hi = float(samples.min()), float(samples.max())
                if lo == hi:
                    lo, hi = lo - .5, hi + .5
            else:
                try:
                    lo, hi = map(float, bounds)
                    if not math.isfinite(lo) or not math.isfinite(hi) or lo >= hi:
                        raise ValueError()
                except (TypeError, ValueError):
                    raise ValueError('Histogram range: enter a finite lower and upper limit, with the lower first.')
            raw_bins = data.get('bins')
            automatic = raw_bins is None or (isinstance(raw_bins, str) and not raw_bins.strip())
            if automatic:
                span = hi - lo
                if not math.isfinite(span) or span > MAX_BINS:
                    raise ValueError(f'This range would need more than {MAX_BINS} automatic bins. Enter a bin count from 1 to {MAX_BINS}, or narrow the range.')
                bins = max(1, math.ceil(span))
            else:
                try:
                    bins = float(raw_bins)
                    if not bins.is_integer() or not 1 <= bins <= MAX_BINS:
                        raise ValueError()
                except (ValueError, TypeError, OverflowError):
                    raise ValueError(f'Enter a whole number of bins from 1 to {MAX_BINS}, or leave it blank to use the range width.')
            edges = np.linspace(lo, hi, int(bins) + 1)
    elif source != 'counts':
        raise ValueError('Choose individual measurements or pre-binned counts.')
    if not 2 <= len(edges) <= MAX_BINS + 1 or not np.isfinite(edges).all() or not (np.diff(edges) > 0).all():
        raise ValueError(f'Enter 2 to {MAX_BINS + 1} strictly increasing bin edges (one more edge than counts).')
    if source == 'samples':
        # Include the final right edge, consistently in raw and pre-binned data.
        counts, _ = np.histogram(samples, bins=edges)
        counts = counts.astype(float)
        underflow, overflow = int((samples < edges[0]).sum()), int((samples > edges[-1]).sum())
    else:
        counts = numbers(data, 'counts', True)
        if len(counts) != len(edges) - 1:
            raise ValueError(f'{len(counts)} counts need {len(counts) + 1} bin edges; {len(edges)} were entered.')
        if (counts < 0).any() or not np.equal(counts, np.floor(counts)).all():
            raise ValueError('Counts need to be nonnegative whole numbers. Use original counts, before normalization or background subtraction.')
    if not np.isfinite(counts.sum()):
        raise ValueError('The total count is too large. Check the entered counts.')
    if not counts.sum() > 0:
        raise ValueError('There are no counts inside these bin edges. Widen the range or enter measurements within it.')
    return edges, counts, underflow, overflow


def run_histogram(data, formula='', par_names=None, par_guesses=None, x_range=None,
                  title='', x_title='', y_title='', plot=None, fit_model=True):
    edges, counts, underflow, overflow = prepare(data)
    widths, centers = np.diff(edges), (edges[1:] + edges[:-1]) / 2
    plot = plot or {}
    configs = diagnostics.configurations(plot)
    if plot.get('logx') and edges[0] <= 0:
        raise ValueError('A logarithmic X axis needs all bin edges above zero. Adjust the edges or turn off Log X.')
    method = data.get('method', 'poisson')
    if method not in ('poisson', 'chi2'):
        raise ValueError('Choose Poisson likelihood or chi-square for the histogram fit.')
    lo, hi = float(edges[0]), float(edges[-1])
    if x_range is not None:
        try:
            lo = lo if x_range[0] is None else float(x_range[0])
            hi = hi if x_range[1] is None else float(x_range[1])
            if not math.isfinite(lo) or not math.isfinite(hi) or not lo < hi:
                raise ValueError()
        except (TypeError, ValueError, IndexError):
            raise ValueError('The fit range needs finite limits in increasing order.')
    inside = (centers >= lo) & (centers <= hi)
    eligible = inside if method == 'poisson' else inside & (counts > 0)
    hist = ROOT.TH1D('histogram_counts', '', len(counts), array('d', edges))
    hist.SetDirectory(0)
    for i, count in enumerate(counts, 1):
        hist.SetBinContent(i, float(count))
        hist.SetBinError(i, math.sqrt(count))
    hist.SetEntries(float(counts.sum()))
    notes = []
    if underflow or overflow:
        notes.append(f'Outside the histogram: {underflow} below the first edge and {overflow} above the last edge; these measurements were not fitted.')
    notes.append('The plot shows counts per unit X. The model is a count density; its integral over each bin predicts that bin’s count. The final right edge is included.')
    fitted, params, covariance, panels, residuals = None, [], [], [], {'kind': 'none'}
    status, ndf, statistic, probability, expected = 0, 0, None, None, []
    valid = True
    if fit_model:
        fitted = ROOT.TF1('histogram_model', formula, lo, hi)
        if not fitted.IsValid() or fitted.GetNpar() == 0:
            raise ValueError('Choose a fit function with at least one parameter, such as gaus or [0].')
        if int(eligible.sum()) <= fitted.GetNpar():
            raise ValueError(f'This model has {fitted.GetNpar()} parameters and only {int(eligible.sum())} usable bins in the fit range. Use more bins, a wider range, or fewer parameters.')
        # Estimate starts using only bins included in this fit. User guesses below
        # still override these values, including individual partial guesses.
        fit_counts, fit_centers, fit_widths = counts[inside], centers[inside], widths[inside]
        if not fit_counts.sum():
            raise ValueError('The selected fit range contains no counts. Widen the range to include data.')
        density = fit_counts / fit_widths
        mean = float(np.average(fit_centers, weights=fit_counts))
        sigma = max(float(np.sqrt(np.average((fit_centers-mean)**2, weights=fit_counts))), float(fit_widths.min()))
        if formula in ('gaus', 'gausn'):
            fitted.SetParameters(float(fit_counts.sum()) if formula == 'gausn' else float(density.max()), mean, sigma)
        elif formula == 'gaus(0)+pol0(3)':
            background = float(density.min())
            peak_counts = np.maximum(fit_counts - background * fit_widths, 0)
            if peak_counts.sum():
                mean = float(np.average(fit_centers, weights=peak_counts))
                sigma = max(float(np.sqrt(np.average((fit_centers-mean)**2, weights=peak_counts))), float(fit_widths.min()))
            fitted.SetParameters(max(float(density.max())-background, 1.), mean, sigma, background)
        elif formula == 'landau':
            location = float(fit_centers[np.argmax(density)])
            fitted.SetParameters(1., location, max(sigma / 3, float(fit_widths.min())))
            fitted.SetParameter(0, float(density.max()) / fitted.Eval(location))
        elif formula == 'expo':
            positive = density > 0
            slope, intercept = 0., math.log(float(fit_counts.sum() / fit_widths.sum()))
            if int(positive.sum()) >= 2:
                slope, intercept = np.polyfit(fit_centers[positive], np.log(density[positive]), 1)
            fitted.SetParameters(float(intercept), float(slope))
        elif formula in ('[0]', 'pol0'):
            fitted.SetParameter(0, float(fit_counts.sum() / fit_widths.sum()))
        for i, name in enumerate(par_names or []):
            if i < fitted.GetNpar() and name:
                fitted.SetParName(i, name)
        for i, guess in enumerate(par_guesses or []):
            if i < fitted.GetNpar() and guess is not None:
                fitted.SetParameter(i, guess)
        # WIDTH treats f as a density; I integrates it over the actual bin.
        # B retains our supplied starting parameters even for named functions.
        result_ptr = hist.Fit(fitted, 'SQRIBNWIDTH' + ('L' if method == 'poisson' else ''))
        result = result_ptr.Get()
        if not result:
            raise ValueError('The histogram fit could not start. Try another model or starting values.')
        status, valid = int(result.Status()), bool(result.IsValid())
        ndf = int(result.Ndf())
        expected = np.array([fitted.Integral(float(a), float(b)) for a, b in zip(edges[:-1], edges[1:])])
        if not np.isfinite(expected).all() or (expected[inside] < 0).any() or ((expected[inside] == 0) & (counts[inside] > 0)).any():
            raise ValueError('The fitted model does not predict valid counts in every fitted bin. Try a positive model or different starting values.')
        if method == 'poisson':
            observed, predicted = counts[inside], expected[inside]
            terms = predicted - observed
            positive = observed > 0
            terms[positive] += observed[positive] * np.log(observed[positive] / predicted[positive])
            statistic = max(0., float(2 * terms.sum()))
            notes.append('Poisson deviance includes empty bins. A χ² p-value is not reported for this likelihood fit; its approximation can be unreliable for sparse counts.')
        else:
            statistic = float(np.sum((counts[eligible] - expected[eligible])**2 / counts[eligible]))
            probability = float(ROOT.TMath.Prob(statistic, ndf)) if ndf > 0 else None
            notes.append('χ² uses √count uncertainties and excludes zero-count bins. Poisson likelihood is preferable for sparse counts.')
        notes.append('Fit ranges select bins by their centers; the full selected bins enter the fit.')
        params = [dict(index=i, name=fitted.GetParName(i), value=float(fitted.GetParameter(i)), error=float(fitted.GetParError(i))) for i in range(fitted.GetNpar())]
        covariance = [[float(result.CovMatrix(i,j)) for j in range(fitted.GetNpar())] for i in range(fitted.GetNpar())]
        # Diagnostics compare actual bin counts with integrated predictions.
        class BinPrediction:
            def Eval(self, x): return expected[int(np.argmin(abs(centers-x)))]
            def Derivative(self, x): return 0.
        sigma = np.sqrt(np.maximum(expected, 0)) if method == 'poisson' else np.sqrt(counts)
        panels, diagnostic_notes, residuals = diagnostics.calculate(configs, centers, counts, np.zeros(len(counts)), sigma, BinPrediction(), lo, hi)
        notes.extend(diagnostic_notes)
        if any(p['kind'] == 'pull' for p in panels):
            notes.append('Histogram pulls use (count − predicted count) / √predicted count for Poisson fits, or / √count for χ² fits; these are approximate standardized residuals.')
        fitted.SetNpx(400)
        fitted.SetLineColor(ROOT.kRed)
    display = hist.Clone('histogram_density')
    display.SetDirectory(0)
    display.Scale(1., 'width')
    display.SetStats(False)
    display.SetTitle(f'{_safe_title(title)};{_safe_title(x_title)};{_safe_title(y_title or "Counts / unit X")}')
    display.SetLineColor(ROOT.kBlue + 1)
    display.SetMarkerStyle(20)
    summary = [f'Counts = {int(counts.sum())}']
    if fit_model:
        summary.append('Poisson likelihood' if method == 'poisson' else 'Chi-square fit')
        label = 'Deviance' if method == 'poisson' else '#chi^{2}'
        summary.append(f'{label} / NDF = {statistic:.4g} / {ndf}')
        if probability is not None:
            summary.append(f'p-value = {probability:.3g}')
        if not (status == 0 and valid):
            summary.append('Fit not converged')
        for parameter in params:
            name = _safe_title(parameter['name'])
            if name.lower() == 'sigma': name = '#sigma'
            summary.append(f"{name} = {parameter['value']:.4g} #pm {parameter['error']:.2g}")
    else:
        if data.get('source', 'samples') == 'samples':
            values = np.asarray(data['samples'], dtype=float)
            values = values[(values >= edges[0]) & (values <= edges[-1])]
            mean, std = float(values.mean()), float(values.std())
            prefix = ''
        else:
            mean = float(np.average(centers, weights=counts))
            std = float(np.sqrt(np.average((centers-mean)**2, weights=counts)))
            prefix = 'Binned '
        summary += [f'{prefix}mean = {mean:.4g}', f'{prefix}std. dev. = {std:.4g}']
    band = confidence_band(result, fitted, lo, hi, plot) if fit_model else None
    if fit_model and plot.get('confidence_level') and band is None:
        notes.append('Confidence band unavailable: the fit needs a valid, accurate covariance matrix.')
    rendered = render_fit_plot(display, fitted, panels, plot, x_title, lo, hi, 'E1 HIST', summary, band=band)
    return dict(confidence_band=band, analysis_type='histogram', fit_performed=fit_model, method=method,
                status=status, converged=status == 0 and valid,
                status_message=STATUS_MESSAGES.get(status, f'Minuit status {status}') if fit_model else 'Histogram plotted.',
                formula=formula if fit_model else '', range=[lo,hi], n_points=int(eligible.sum()),
                params=params, covariance=covariance, chi2=statistic if method=='chi2' else None,
                chi2_ndf=statistic/ndf if method=='chi2' and ndf>0 else None, ndf=ndf, prob=probability,
                statistic=statistic, statistic_name='Poisson deviance' if method=='poisson' else 'χ²',
                histogram=dict(edges=edges.tolist(), counts=counts.tolist(), total=int(counts.sum()),
                               underflow=underflow, overflow=overflow, expected=np.asarray(expected).tolist()),
                diagnostics=panels, residuals=residuals, plot_notes=notes, **rendered)
