"""Histogram and vector-model adapters for the shared bounded ROOT search.

These adapters provide predictions and residuals, leaving deadlines, bounds,
optimization, cancellation, and result ownership to parameter_search/search_jobs.
"""
import re

import numpy as np
import ROOT
from parameter_search import _array, _model, _hints, MAX_POINTS


def problem(payload):
    return histogram(payload) if payload['analysis_type'] == 'histogram' else multivariate(payload)


def histogram(payload):
    from histogram_fit import prepare
    data = payload.get('histogram')
    edges, counts, underflow, overflow = prepare(data)
    method = data.get('method', 'poisson')
    if method not in ('poisson', 'chi2'):
        raise ValueError('Choose Poisson likelihood or chi-square for the histogram search.')
    centers, widths = (edges[:-1] + edges[1:]) / 2, np.diff(edges)
    limits = payload.get('x_range')
    if limits is None:
        limits = [edges[0], edges[-1]]
    if not isinstance(limits, (list, tuple)) or len(limits) != 2:
        raise ValueError('The fit range needs a minimum and a maximum.')
    lo, hi = [float(edges[0 if i == 0 else -1]) if v is None else float(v) for i, v in enumerate(limits)]
    if not np.isfinite([lo, hi, hi - lo]).all() or lo >= hi:
        raise ValueError('The fit range needs finite limits in increasing order.')
    inside = (centers >= lo) & (centers <= hi)
    if not counts[inside].sum():
        raise ValueError('The selected fit range contains no counts. Widen the range to include data.')
    selected = inside if method == 'poisson' else inside & (counts > 0)
    if not selected.any():
        raise ValueError('No usable histogram bins are inside the fit range.')
    x, y = centers[selected], counts[selected]
    a, b = edges[:-1][selected], edges[1:][selected]
    function, expression, names, guesses = _model(payload, lo, hi)
    # Heuristics use density rather than raw counts, retaining correct units
    # with unequal-width bins. Include empty bins in the shape estimates.
    hx = centers[inside]
    if len(hx) == 1:
        hx = np.array([edges[:-1][inside][0], edges[1:][inside][0]])
        hy = np.repeat(counts[inside] / widths[inside], 2)
    else:
        hy = counts[inside] / widths[inside]
    hints, peaks = _hints(hx, hy, expression, names)
    if payload.get('formula', '').strip() == 'gausn':
        hints[0]['initial'] = float(counts[inside].sum())
        hints[0]['upper'] = max(hints[0]['upper'], hints[0]['initial'] * 100)
        hints[0]['scale'] = hints[0]['initial']
    quadratures = []
    for order in (16, 32, 64, 128):
        nodes, weights = np.polynomial.legendre.leggauss(order)
        points = (a[:, None] + b[:, None]) / 2 + (b - a)[:, None] / 2 * nodes
        quadratures.append((np.ascontiguousarray(points.reshape(-1, 1)), weights, order))

    def evaluate(values):
        previous = None
        converged = np.zeros(len(x), dtype=bool)
        for points, weights, order in quadratures:
            density = np.asarray(function.EvalPar(points, np.ascontiguousarray(values)), dtype=float).reshape(len(x), order)
            current = density @ weights * (b - a) / 2
            if previous is not None:
                converged = np.isclose(current, previous, rtol=1e-7, atol=1e-9)
                if converged.all():
                    return current
            previous = current
        # ROOT adaptive integration covers sharply varying or discontinuous
        # models that have not converged under increasing quadrature orders.
        function.SetParameters(np.ascontiguousarray(values))
        for i in np.flatnonzero(~converged):
            current[i] = function.Integral(float(a[i]), float(b[i]), 1e-8)
        return current

    def residual(values, predicted):
        if (predicted < 0).any() or ((predicted <= 0) & (y > 0)).any():
            return np.full(len(y), np.nan)
        if method == 'chi2':
            return (predicted - y) / np.sqrt(y)
        terms = predicted - y
        positive = y > 0
        terms[positive] += y[positive] * np.log(y[positive] / predicted[positive])
        return np.sign(predicted - y) * np.sqrt(np.maximum(2 * terms, 0))

    def preview(values):
        predicted = evaluate(values)
        return dict(x=x.tolist(), y=predicted.tolist(), data_x=x.tolist(), data_y=y.tolist(),
                    title='Suggested counts per bin', x_label='Bin center', y_label='Counts',
                    note='Dark points are observed counts; blue points show predicted counts integrated over each selected bin.')

    notes = ['The model is a count density. Search predictions integrate it over the full selected bins. '
             + ('Poisson deviance includes empty bins.' if method == 'poisson' else 'Chi-square uses √count uncertainties and excludes empty bins.')]
    if underflow or overflow:
        notes.append(f'Measurements outside the histogram are omitted: {underflow} below and {overflow} above the edges.')
    return dict(x=x, y=y, function=function, expression=expression, names=names, guesses=guesses,
                limits=(lo, hi), hints=hints, peaks=peaks, evaluate=evaluate, residual=residual,
                preview=preview, n_observations=len(y), optimization_scale=1., notes=notes,
                score_description='Poisson deviance (including empty bins).' if method == 'poisson'
                else 'Chi-square using observed count uncertainties (empty bins omitted).')


def multivariate(payload):
    def dimension(key):
        raw = payload.get(key)
        try:
            value = int(raw)
            if isinstance(raw, bool) or value != float(raw) or not 1 <= value <= 20:
                raise ValueError()
        except (TypeError, ValueError, OverflowError):
            raise ValueError('Choose between 1 and 20 inputs and outputs.') from None
        return value
    n, m = dimension('n_inputs'), dimension('n_outputs')
    def columns(key, count, length=None, errors=False):
        raw = payload.get(key)
        if raw is None and errors:
            raw = [None] * count
        if not isinstance(raw, list) or len(raw) != count:
            raise ValueError(f'{key} needs exactly {count} columns.')
        return [_array(col, f'{key} column {i + 1}', length, errors) for i, col in enumerate(raw)]
    inputs = columns('inputs', n)
    N = len(inputs[0])
    if not 1 <= N <= MAX_POINTS or N * m > MAX_POINTS:
        raise ValueError(f'Search supports at most {MAX_POINTS:,} output measurements in total.')
    if any(len(col) != N for col in inputs):
        raise ValueError('Every input column needs the same number of rows.')
    outputs = columns('outputs', m, N)
    sx, sy = columns('input_errors', n, N, True), columns('output_errors', m, N, True)
    models = payload.get('models')
    if not isinstance(models, list) or len(models) != m:
        raise ValueError('Enter one model for each output.')
    # Numeric indices make the sharing convention explicit and predictable.
    if any(re.search(r'\[(?!\d+\])[^\]]+\]', str(model)) for model in models):
        raise ValueError('Use numeric parameter indices [0], [1], … in multivariate models.')
    ranges = payload.get('input_ranges') or []
    if not isinstance(ranges, list) or len(ranges) > n:
        raise ValueError('Supply at most one fit range per input.')
    mask = np.ones(N, dtype=bool)
    for d, limits in enumerate(ranges):
        if limits in (None, '', []):
            continue
        limits = _array(limits, f'Fit range for x{d}')
        if len(limits) != 2 or limits[0] >= limits[1]:
            raise ValueError('Input fit ranges need a finite minimum and a larger maximum.')
        mask &= (inputs[d] >= limits[0]) & (inputs[d] <= limits[1])
    if not mask.any():
        raise ValueError('No measurements are inside the input fit ranges.')
    X, Y, SX, SY = [np.column_stack(cols)[mask] for cols in (inputs, outputs, sx, sy)]
    if not np.isfinite(np.ptp(X, axis=0)).all():
        raise ValueError('Input ranges are too large; rescale your input units.')
    functions, expressions, model_names, model_guesses = [], [], [], []
    variables = tuple(f'x{d}' for d in range(n))
    for model in models:
        f, expression, names, guesses = _model(dict(payload, formula=model), 0., 1., variables, allow_constant=True)
        functions.append(f)
        expressions.append(re.sub(r'x\[(\d+)\]', r'x\1', expression))
        model_names.append(names)
        model_guesses.append(guesses)
    count = max(map(len, model_names))
    if count == 0:
        raise ValueError('These models have no adjustable parameters to search for.')
    explicit_count = max([int(index) + 1 for model in models for index in re.findall(r'\[(\d+)\]', str(model))], default=0)
    if explicit_count < count:
        raise ValueError('Write multivariate parameters explicitly as [0], [1], … so Search and Fit use the same shared parameter vector.')
    names, guesses = next((nm, gs) for nm, gs in zip(model_names, model_guesses) if len(nm) == count)
    hints = [None] * count
    roles = dict(center=8, width=7, frequency=6, envelope_frequency=6, phase=5,
                 fraction=5, slope=4, polynomial=4, background=3, rate=3, exponent=2, amplitude=1)
    for k, expression in enumerate(expressions):
        for d in range(n):
            # Separate each input's units when generating hints; the objective
            # always evaluates the original model with every actual input.
            mapped = re.sub(r'\bx(\d+)\b', lambda match: 'x' if int(match[1]) == d else
                            '(' + repr(float(np.mean(X[:, int(match[1])]))) + ')', expression)
            hx = X[:, d]
            hy = Y[:, k]
            if np.ptp(hx) == 0:
                radius = max(abs(float(hx[0])) * 1e-6, .5)
                hx = np.array([hx[0] - radius, hx[0] + radius])
                if not np.isfinite(hx).all():
                    raise ValueError('Input magnitudes are too large; rescale your input units.')
                hy = np.repeat(np.mean(hy), 2)
            proposed, _ = _hints(hx, hy, mapped, names)
            for j, hint in enumerate(proposed):
                if f'[{j}]' not in expression:
                    continue
                specific = bool(re.search(r'\bx' + str(d) + r'\b', expression))
                if hints[j] is None or specific and roles.get(hint['role'], 0) > roles.get(hints[j]['role'], 0):
                    hints[j] = hint
    generic, _ = _hints(np.array([0., 1.]), np.array([Y.min(), Y.max()]), '', names)
    hints = [hint or generic[j] for j, hint in enumerate(hints)]
    # Evaluate TFormula in one C++ loop: ROOT's TF1 NumPy helper is limited
    # to scalar functions, while these models may have up to twenty inputs.
    if not hasattr(ROOT, 'RootatronSearch'):
        ROOT.gInterpreter.Declare("""
            namespace RootatronSearch {
                std::vector<double> EvaluateFormula(TFormula &f, const double *x,
                    const double *p, size_t rows, size_t dims) {
                    std::vector<double> result(rows);
                    for (size_t i = 0; i < rows; ++i)
                        result[i] = f.EvalPar(x + i * dims, p);
                    return result;
                }
            }
        """)
    coords = np.ascontiguousarray(X)
    h = np.where(np.abs(X) > 0, np.abs(X) * 1e-6, 1e-6)
    def predictions(values, points=coords):
        values = np.ascontiguousarray(values)
        return np.column_stack([np.asarray(ROOT.RootatronSearch.EvaluateFormula(f, np.ascontiguousarray(points), values, len(points), n), dtype=float).reshape(-1) for f in functions])
    def evaluate(values):
        return predictions(values).reshape(-1)
    def residual(values, predicted):
        variance = SY ** 2
        for d in range(n):
            rows = SX[:, d] > 0
            if not rows.any():
                continue
            plus, minus = coords[rows].copy(), coords[rows].copy()
            plus[:, d] += h[rows, d]
            minus[:, d] -= h[rows, d]
            derivative = (predictions(values, plus) - predictions(values, minus)) / (2 * h[rows, d, None])
            variance[rows] += (derivative * SX[rows, d, None]) ** 2
        if not np.isfinite(variance).all():
            return np.full(Y.size, np.nan)
        errors = np.sqrt(np.where(variance > 0, variance, 1.))
        return ((predicted.reshape(Y.shape) - Y) / errors).reshape(-1)
    labels = payload.get('output_names') or []
    def preview(values):
        predicted = predictions(values)
        if not np.isfinite(predicted).all():
            raise ValueError('The suggested model is undefined at some measurements.')
        return dict(panels=[dict(x=Y[:, k].tolist(), y=predicted[:, k].tolist(),
                    data_x=Y[:, k].tolist(), data_y=predicted[:, k].tolist(),
                    reference=True, title=str(labels[k]) if k < len(labels) and labels[k] else f'Output {k + 1}',
                    x_label='Measured', y_label='Predicted') for k in range(m)],
                    note='Each point compares a measured output with its model prediction using all inputs. Points near the diagonal agree. This is a starting-value check, not a fitted surface.')
    return dict(x=np.arange(len(X), dtype=float), y=Y.reshape(-1), function=functions[0],
                expression=';'.join(expressions), names=names, guesses=guesses, hints=hints, peaks=[],
                limits=(0., float(max(1, len(X) - 1))), evaluate=evaluate, residual=residual, preview=preview,
                n_observations=Y.size, optimization_scale=(1. if np.any(SY > 0) or np.any(SX > 0)
                else max(float(np.std(Y)), float(np.max(np.abs(Y))) * .001, np.finfo(float).tiny ** .25)),
                notes=['All outputs are searched together. Parameters with the same [index] remain shared. Input and output uncertainties use effective variance.'],
                score_description='Sum of squared residuals over every output, using input/output uncertainties through effective variance.')
