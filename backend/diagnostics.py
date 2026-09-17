"""Optional fit diagnostics and their display settings (no ROOT drawing here)."""
import math
import numpy as np

DEFAULTS = {
    'residual': ('Residuals', 'data - fit'),
    'pull': ('Pulls', '(data - fit) / #sigma'),
    'ratio': ('Data / fit', 'data / fit'),
    'percent': ('Percentage difference', '100 (data - fit) / fit [%]'),
    'histogram': ('Residual distribution', 'Number of points'),
}


def configurations(plot):
    raw = plot.get('diagnostics')
    if raw is None:  # Documents and clients using the original single panel.
        legacy = plot.get('residuals', 'none') or 'none'
        raw = [] if legacy == 'none' else [{'kind': legacy}]
    if not isinstance(raw, list) or len(raw) > len(DEFAULTS):
        raise ValueError('Optional plots must be a list of at most five plot types.')
    out, seen = [], set()
    for entry in raw:
        if not isinstance(entry, dict) or entry.get('kind') not in DEFAULTS:
            raise ValueError('Choose residuals, pulls, data/fit ratio, percentage difference, or a residual histogram.')
        kind = entry['kind']
        if kind in seen:
            raise ValueError('Each optional plot can be selected once.')
        seen.add(kind)
        title, ylabel = DEFAULTS[kind]
        cfg = dict(kind=kind, title=str(entry.get('title') or title)[:160],
                   x_title=str(entry.get('x_title') or '')[:160],
                   y_title=str(entry.get('y_title') or ylabel)[:160])
        for key, default, low, high in [('height', 240, 180, 480), ('bins', 15, 5, 100)]:
            try:
                v = float(entry.get(key, default))
                if not math.isfinite(v) or not v.is_integer() or not low <= v <= high:
                    raise ValueError()
            except (ValueError, TypeError, OverflowError):
                raise ValueError(f'{title}: {key} needs a whole number from {low} to {high}.')
            cfg[key] = int(v)
        for key in ('y_min', 'y_max'):
            raw_value = entry.get(key)
            try:
                cfg[key] = None if raw_value in (None, '') else float(raw_value)
                if cfg[key] is not None and not math.isfinite(cfg[key]):
                    raise ValueError()
            except (ValueError, TypeError, OverflowError):
                raise ValueError(f'{title}: axis limits need finite numbers, or can be left blank.')
        if cfg['y_min'] is not None and cfg['y_max'] is not None and cfg['y_min'] >= cfg['y_max']:
            raise ValueError(f'{title}: the lower Y limit needs to be smaller than the upper limit.')
        cfg['scope'] = entry.get('scope', 'fit')
        if cfg['scope'] not in ('fit', 'all'):
            raise ValueError(f'{title}: choose points in the fit range or all points.')
        for key in ('grid', 'reference', 'errors'):
            cfg[key] = entry.get(key, True) is not False
        out.append(cfg)
    return out


def calculate(configs, x, y, ex, ey, fitted, xmin, xmax):
    if not configs:
        return [], [], {'kind': 'none'}
    with np.errstate(all='ignore'):
        model = np.array([fitted.Eval(float(v)) for v in x])
        residual = y - model
        slope = np.array([fitted.Derivative(float(v)) for v in x])
        # An undefined derivative does not affect a point with no X uncertainty.
        x_effect = np.zeros(len(x))
        np.multiply(slope, ex, out=x_effect, where=ex != 0)
        sigma = np.hypot(ey, x_effect)
    panels, notes = [], []
    summary = {'kind': 'none'}
    for cfg in configs:
        kind = cfg['kind']
        scope = (x >= xmin) & (x <= xmax) if cfg['scope'] == 'fit' else np.ones(len(x), dtype=bool)
        valid = scope & np.isfinite(residual) & np.isfinite(sigma)
        with np.errstate(all='ignore'):
            if kind == 'pull':
                valid &= sigma > 0
                values, errors, baseline = residual / sigma, np.ones(len(x)), 0.0
            elif kind in ('ratio', 'percent'):
                valid &= model != 0
                values = y / model if kind == 'ratio' else 100 * residual / model
                errors = sigma / np.abs(model) * (100 if kind == 'percent' else 1)
                baseline = 1.0 if kind == 'ratio' else 0.0
            else:
                values, errors, baseline = residual, sigma, 0.0
        valid &= np.isfinite(values) & np.isfinite(errors)
        skipped = int(scope.sum() - valid.sum())
        if skipped:
            reason = 'a positive uncertainty' if kind == 'pull' else 'a nonzero fitted value' if kind in ('ratio', 'percent') else 'finite calculated values'
            notes.append(f"{cfg['title']}: {skipped} point(s) could not be shown; this plot needs {reason}.")
        if not valid.any():
            notes.append(f"{cfg['title']} was omitted because no usable points remain. The main fit is still shown.")
            continue
        panel = dict(cfg, x=x[valid].tolist(), values=values[valid].tolist(),
                     x_errors=ex[valid].tolist(), errors_values=errors[valid].tolist(),
                     baseline=baseline, skipped=skipped, n_points=int(valid.sum()))
        if kind == 'histogram':
            lo, hi = float(values[valid].min()), float(values[valid].max())
            padding = (hi - lo) * .05 if hi > lo else max(abs(lo) * .05, .5)
            counts, edges = np.histogram(values[valid], bins=cfg['bins'], range=(lo-padding, hi+padding))
            panel.update(counts=counts.tolist(), edges=edges.tolist())
        panels.append(panel)
        if kind in ('residual', 'pull') and summary['kind'] == 'none':
            summary = dict(kind=kind, values=residual[valid].tolist(), sigma=sigma[valid].tolist(),
                           x_values=x[valid].tolist(), fit_values=model[valid].tolist(),
                           pull_available=bool((sigma[valid] > 0).all()))
    return panels, notes, summary
