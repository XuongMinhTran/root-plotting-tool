"""Bounded, best-effort starting-value search for the accepted ROOT fit models.

The formula is evaluated by ROOT, never translated or evaluated as Python.  A
search runs in the server's disposable process: its caller owns cancellation
and the hard deadline.  No fit, covariance, canvas, or global ROOT fit settings
are produced here.  Search bounds constrain this search only.
"""

import math
import re
import time
import uuid

import numpy as np
import ROOT

from formula_check import check_formula

MAX_PARAMETERS = 20
MAX_POINTS = 100000
INVALID_SCORE = 1e100


def _array(value, name, length=None, errors=False):
    if errors and value is None:
        return np.zeros(length)
    try:
        array = np.asarray(value, dtype=np.float64)
    except (ValueError, TypeError, OverflowError):
        raise ValueError(f"{name} must contain finite numbers.") from None
    if errors and array.ndim == 0:
        array = array.reshape(1)
    if array.ndim != 1 or not np.isfinite(array).all():
        raise ValueError(f"{name} must be a list of finite numbers.")
    if errors and len(array) == 0:
        return np.zeros(length)
    if errors and len(array) == 1:
        array = np.full(length, array[0])
    if length is not None and len(array) != length:
        raise ValueError(f"{name} must have the same number of points as x.")
    if errors and np.any(array < 0):
        raise ValueError("Uncertainties must not be negative.")
    return array


def _list(value, name):
    if value is None or value == "":
        return []
    if isinstance(value, str):
        return [part.strip() for part in value.split(",")]
    if not isinstance(value, (list, tuple)):
        raise ValueError(f"{name} must be a list.")
    return list(value)


def _inputs(payload):
    if not isinstance(payload, dict):
        raise ValueError("Search input must be an object.")
    x = _array(payload.get("x"), "x")
    y = _array(payload.get("y"), "y", len(x))
    if len(x) < 2 or len(x) > MAX_POINTS:
        raise ValueError(f"Search needs between 2 and {MAX_POINTS:,} points.")
    ex = _array(payload.get("ex"), "ex", len(x), errors=True)
    ey = _array(payload.get("ey"), "ey", len(x), errors=True)
    chosen = payload.get("x_range")
    if chosen is not None and chosen != [] and chosen != "":
        limits = _array(chosen, "x_range")
        if len(limits) != 2 or limits[0] >= limits[1]:
            raise ValueError("x_range must contain a finite minimum and a larger maximum.")
        low, high = limits
    else:
        low, high = float(np.min(x)), float(np.max(x))
    mask = (x >= low) & (x <= high)
    x, y, ex, ey = (a[mask] for a in (x, y, ex, ey))
    if len(x) < 2 or np.min(x) == np.max(x):
        raise ValueError("Search needs at least two distinct x values inside the fit range.")
    if not math.isfinite(high - low):
        raise ValueError("The x range is too large; rescale the x units first.")
    function, expanded, names, guesses = _model(payload, low, high)
    return x, y, ex, ey, function, expanded, names, guesses, (float(low), float(high))


def _model(payload, low, high, variables=("x",), allow_constant=False):
    formula = payload.get("formula", "")
    ok, reason = check_formula(formula, variables=variables)
    if not ok:
        raise ValueError(reason)
    formula = str(formula).strip()
    # Reject oversized built-ins and sparse numeric indices before ROOT allocates
    # their parameter arrays. ROOT's expanded count is also checked below.
    numeric_indices = [int(i) for i in re.findall(r"\[(\d+)\]", formula)]
    orders = [int(i) for i in re.findall(r"\b(?:pol|chebyshev)(\d+)\b", formula)]
    if any(i >= MAX_PARAMETERS for i in numeric_indices + orders):
        raise ValueError(f"Search supports at most {MAX_PARAMETERS} parameters.")
    built_in_sizes = dict(gaus=3, gausn=3, expo=2, landau=3, landaun=3,
                          crystalball=5, crystalballn=5, breitwigner=3)
    for match in re.finditer(r"\b(gausn?|expo|landaun?|crystalballn?|breitwigner|pol\d+|chebyshev\d+)\s*\(\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*\)", formula):
        name, offset = match.group(1), float(match.group(2))
        if not math.isfinite(offset) or offset < 0 or not offset.is_integer():
            raise ValueError("Built-in function parameter offsets must be nonnegative integers.")
        size = built_in_sizes.get(name)
        if size is None:
            size = int(re.search(r"\d+$", name).group()) + 1
        if offset + size > MAX_PARAMETERS:
            raise ValueError(f"Search supports at most {MAX_PARAMETERS} parameters, including built-in function offsets.")
    if variables != ("x",):
        formula = re.sub(r"\bx(\d+)\b", r"x[\1]", formula)
    name = "parameter_search_" + uuid.uuid4().hex
    if variables == ("x",):
        function = ROOT.TF1(name, formula, low, high)
        function.AddToGlobalList(False)
    else:
        function = ROOT.TFormula(name, formula, False)
    if not function.IsValid() or function.GetNdim() > len(variables):
        raise ValueError("ROOT could not parse this model with the selected inputs.")
    count = int(function.GetNpar())
    if count == 0 and not allow_constant:
        raise ValueError("This function has no adjustable parameters to search for.")
    if count > MAX_PARAMETERS:
        raise ValueError(f"Search supports at most {MAX_PARAMETERS} parameters.")
    names = _list(payload.get("param_names"), "param_names")
    raw_guesses = _list(payload.get("initial_guesses"), "initial_guesses")
    guesses = []
    for value in raw_guesses[:count]:
        if value is None or value == "":
            guesses.append(None)
        else:
            try:
                value = float(value)
            except (ValueError, TypeError, OverflowError):
                raise ValueError("Starting values must be finite numbers or blank.") from None
            if not math.isfinite(value):
                raise ValueError("Starting values must be finite numbers or blank.")
            guesses.append(value)
    guesses += [None] * (count - len(guesses))
    expanded = str(function.GetExpFormula()).replace(" ", "")
    for i in range(count):
        expanded = expanded.replace("[" + function.GetParName(i) + "]", f"[{i}]")
    names = [str(names[i]).strip() if i < len(names) and names[i] else
             str(function.GetParName(i)) for i in range(count)]
    return function, expanded, names, guesses


def _function_arguments(expression):
    """Locate nested mathematical calls for conservative parameter role hints."""
    calls = []
    for match in re.finditer(r"([A-Za-z_:]+)\(", expression):
        start, depth = match.end(), 1
        for end in range(start, len(expression)):
            depth += (expression[end] == "(") - (expression[end] == ")")
            if depth == 0:
                calls.append((match.group(1).lower().split("::")[-1], expression[start:end]))
                break
    return calls


def _hints(x, y, expression, names):
    xmin, xmax = float(x.min()), float(x.max())
    span = xmax - xmin
    xsize = max(abs(xmin), abs(xmax), span, np.finfo(float).tiny ** .25)
    floor, top = np.percentile(y, [10, 90])
    tiny_scale = np.finfo(float).tiny ** .25
    amplitude = max(float(top - floor), float(np.std(y)), abs(float(np.median(y))) * .1, tiny_scale)
    ysize = max(float(np.max(np.abs(y))), amplitude, tiny_scale)
    weights = np.maximum(y - floor, 0)
    center = float(np.average(x, weights=weights)) if weights.sum() > 0 else float(np.mean(x))
    width = max(float(np.sqrt(np.average((x - center) ** 2, weights=weights)))
                if weights.sum() > 0 else span / 4, span / 100)
    # A uniform interpolation is only used to suggest frequencies, never to score
    # the fit. Subsequent fitting always uses the original (possibly uneven) x.
    order = np.argsort(x)
    unique, indices = np.unique(x[order], return_index=True)
    ordered_y = y[order][indices]
    sample_count = min(2048, max(64, len(unique)))
    grid = np.linspace(xmin, xmax, sample_count)
    signal = np.interp(grid, unique, ordered_y)
    trend = np.linspace(signal[0], signal[-1], sample_count)
    spectrum = np.abs(np.fft.rfft((signal - trend) * np.hanning(sample_count), n=sample_count * 4))
    frequencies = np.fft.rfftfreq(sample_count * 4, d=span / (sample_count - 1)) * 2 * np.pi
    spacing = float(np.median(np.diff(unique)))
    frequency_limit = min(100 * np.pi / span, np.pi / spacing)
    valid = np.flatnonzero((frequencies >= np.pi / span) & (frequencies <= frequency_limit))
    peaks = []
    for i in valid[np.argsort(spectrum[valid])[::-1]]:
        if all(abs(frequencies[i] - frequency) > 2 * np.pi / span for frequency in peaks):
            peaks.append(float(frequencies[i]))
        if len(peaks) == 6:
            break
    if not peaks:
        peaks = [2 * np.pi / span]
    calls = _function_arguments(expression)
    suggestions = []
    for i, name in enumerate(names):
        token = f"[{i}]"
        pattern = re.escape(token)
        norm_name = re.sub(r"[^a-z0-9]", "", name.lower())
        contexts = [(fn, arg) for fn, arg in calls if token in arg]
        trig = [arg for fn, arg in contexts if fn in ("sin", "cos")]
        exponential = [arg for fn, arg in contexts if fn in ("exp",)]
        shifted_x = bool(re.search(r"x-\(*" + pattern, expression))
        divisor = bool(re.search(r"/\(*" + pattern + r"(?![\*^])", expression))
        role, multiplier, power = "coefficient", 1.0, 0
        degree = re.search(pattern + r"\*x(?:\^(\d+))?", expression)
        powered = re.search(pattern + r"\*(?:pow|TMath::Power)\(x,(\d+)\)", expression)
        if degree:
            power = int(degree.group(1) or 1)
        elif powered:
            power = int(powered.group(1))
        elif re.search(pattern + r"\*TMath::Sq\(x\)", expression):
            power = 2
        if shifted_x or norm_name in ("mean", "center", "centre", "xc", "x0", "x1", "mu") and not exponential:
            role = "center"
        elif norm_name in ("phase", "phi", "angle0"):
            role = "phase"
        elif norm_name in ("v", "visibility", "contrast", "fraction"):
            role = "fraction"
        elif divisor or norm_name in ("sigma", "width", "w", "tau", "gamma", "lifetime"):
            role = "width"
        elif trig:
            role = "frequency" if any("x" in arg and re.search(pattern + r"\*|\*" + pattern, arg) for arg in trig) else "phase"
            if role == "frequency":
                if expression.count(token) > sum(arg.count(token) for arg in trig):
                    role = "envelope_frequency"
                factor = re.search(r"(?<![\w.])([0-9.]+)\*" + pattern, trig[0])
                if factor:
                    multiplier = max(abs(float(factor.group(1))), 1e-12)
        elif exponential:
            role = "rate" if any(re.search(pattern + r"\*\(*x|x\*" + pattern, arg) for arg in exponential) else "exponent"
        elif re.search(r"\^(?:\()?" + pattern, expression) or any(
                fn in ("pow", "power") and arg.endswith("," + token) for fn, arg in contexts):
            role = "exponent"
        elif power or norm_name in ("slope", "bgslope"):
            role = "slope" if power <= 1 else "polynomial"
        elif norm_name in ("background", "offset", "intercept", "nbg", "bgoffset", "tenv"):
            role = "background"
        elif re.search(r"(?:^|\+)" + pattern + r"(?:$|\+|\))", expression):
            role = "background"
        if role == "center":
            initial, lower, upper, scale = center, xmin - span, xmax + span, span
        elif role == "width":
            initial, lower, upper, scale = width, span * 1e-5, span * 100, span
        elif role in ("frequency", "envelope_frequency"):
            initial = (2 / span if role == "envelope_frequency" else peaks[0]) / multiplier
            lower, upper, scale = .001 / span / multiplier, frequency_limit / multiplier, 1 / span
        elif role == "rate":
            initial, lower, upper, scale = 1 / span, -100 / span, 100 / span, 1 / span
        elif role == "phase":
            initial, lower, upper, scale = 0, -4 * np.pi, 4 * np.pi, np.pi
        elif role == "fraction":
            initial, lower, upper, scale = .5, 0, 1, 1
        elif role == "exponent":
            extent = max(20, abs(math.log(ysize)) + 10) if exponential else 20
            initial = math.log(ysize) if exponential else 1
            lower, upper, scale = -extent, extent, 1
        elif role in ("slope", "polynomial"):
            # Logarithms avoid overflow when, for example, a high-order
            # polynomial is expressed in very large or small x units.
            log_scale = math.log(ysize) - max(power, 1) * math.log(xsize)
            scale = math.exp(float(np.clip(log_scale, -340, 340)))
            initial, lower, upper = scale, -100 * scale, 100 * scale
        elif role == "background":
            initial, lower, upper, scale = float(floor), -10 * ysize, 10 * ysize, ysize
        else:
            initial, lower, upper, scale = amplitude, -100 * ysize, 100 * ysize, ysize
        suggestions.append(dict(role=role, initial=float(initial), lower=float(lower),
                                upper=float(upper), scale=float(scale), multiplier=multiplier))
    return suggestions, peaks


def _configuration(payload, require_points=True):
    if not isinstance(payload, dict):
        raise ValueError("Search input must be an object.")
    kind = payload.get("analysis_type", "xy")
    extra = {}
    if kind == "xy":
        x, y, ex, ey, function, expression, names, guesses, limits = _inputs(payload)
        hints, peaks = _hints(x, y, expression, names)
    elif kind in ("histogram", "multivariate"):
        from search_problems import problem
        extra = problem(payload)
        x, y = extra["x"], extra["y"]
        ex, ey = np.zeros(len(x)), np.zeros(len(y))
        function, expression, names, guesses, limits = (extra[key] for key in
            ("function", "expression", "names", "guesses", "limits"))
        hints, peaks = extra["hints"], extra["peaks"]
    else:
        raise ValueError("Choose XY, histogram, or multivariate analysis before searching.")
    raw_bounds = payload.get("bounds")
    if raw_bounds is not None:
        try:
            bounds = np.asarray(raw_bounds, dtype=float)
        except (TypeError, ValueError, OverflowError):
            raise ValueError("Search bounds must be [minimum, maximum] for every parameter.") from None
        if bounds.shape != (len(names), 2) or not np.isfinite(bounds).all():
            raise ValueError("Supply two finite search bounds for every parameter.")
        if np.any(bounds[:, 0] > bounds[:, 1]):
            raise ValueError("A parameter's minimum cannot exceed its maximum.")
    else:
        bounds = np.array([[h["lower"], h["upper"]] for h in hints])
        for i, guess in enumerate(guesses):
            if guess is not None:
                # Current values are evidence about a user's units and scale;
                # retain them even when they contradict a conventional role.
                margin = max(abs(guess) * 4, hints[i]["scale"])
                if guess < bounds[i, 0]:
                    bounds[i, 0] = guess - margin
                if guess > bounds[i, 1]:
                    bounds[i, 1] = guess + margin
    if not np.isfinite(bounds).all() or not np.isfinite(bounds[:, 1] - bounds[:, 0]).all():
        raise ValueError("Parameter scales are too large; rescale the data or give narrower search bounds.")
    free = bounds[:, 0] < bounds[:, 1]
    insufficient = extra.get("n_observations", len(x)) <= int(np.sum(free))
    if require_points and insufficient:
        raise ValueError("Use more points inside the fit range than free parameters, or fix parameters with equal bounds.")
    initial = np.array([h["initial"] if guess is None else guess for h, guess in zip(hints, guesses)])
    warnings = ["Automatic ranges are heuristic. Review them, especially for custom formulas or unusual units."] if raw_bounds is None else []
    if insufficient:
        warnings.append("There are too few points for all parameters. Set equal minimum/maximum bounds to fix some parameters before searching.")
    if np.any((initial < bounds[:, 0]) | (initial > bounds[:, 1])):
        warnings.append("Starting values outside the search ranges were clipped to those ranges.")
    initial = np.clip(initial, bounds[:, 0], bounds[:, 1])
    return dict(extra, x=x, y=y, ex=ex, ey=ey, function=function, expression=expression, names=names,
                hints=hints, peaks=peaks, bounds=bounds, free=free, initial=initial,
                limits=limits, warnings=warnings)


def prepare(payload, require_points=False):
    """Suggest editable bounds; optionally validate enough free-parameter data.

    The prepare dialog can open for an underdetermined problem so users can fix
    parameters there. Use require_points=True to validate before starting a job.
    """
    config = _configuration(payload, require_points=require_points)
    return {"parameters": [dict(index=i, name=name, initial=float(config["initial"][i]),
                                lower=float(config["bounds"][i, 0]), upper=float(config["bounds"][i, 1]))
                           for i, name in enumerate(config["names"])],
            "n_points": len(config["x"]), "n_observations": config.get("n_observations", len(config["x"])),
            "analysis_type": payload.get("analysis_type", "xy"), "warnings": config["warnings"] + config.get("notes", [])}


class _TimeLimit(Exception):
    pass


def search(payload, progress_callback=None):
    """Return finite starting values from a bounded search, never fit uncertainties.

    ValueError means invalid input or no finite candidate found. The sequence of
    proposals is seeded; a wall-clock cutoff can stop it at a different point on
    different machines. The caller must run this in an isolated worker process.
    """
    from scipy.optimize import differential_evolution, least_squares

    if not isinstance(payload, dict):
        raise ValueError("Search input must be an object.")
    try:
        budget = float(payload.get("time_budget", 60))
        seed = int(payload.get("seed", 1729))
    except (TypeError, ValueError, OverflowError):
        raise ValueError("Search time and random seed must be finite numbers.") from None
    if isinstance(payload.get("time_budget"), bool) or not math.isfinite(budget) or budget < 1 or budget > 300:
        raise ValueError("Search time must be between 1 and 300 seconds.")
    if isinstance(payload.get("seed"), bool) or seed != float(payload.get("seed", 1729)) or not 0 <= seed < 2 ** 32:
        raise ValueError("Random seed must be an integer between 0 and 4294967295.")
    config = _configuration(payload)
    function, x, y = config["function"], config["x"], config["y"]
    ex, ey, free = config["ex"], config["ey"], config["free"]
    bounds, initial = config["bounds"], config["initial"]
    dimensions = int(np.sum(free))
    rng = np.random.default_rng(seed)
    started = time.monotonic()
    deadline = started + budget
    evaluations = 0
    best_score, best_values = None, None
    last_progress = 0
    phase = "Trying starting values"
    timed_out = False
    xgrid = np.ascontiguousarray(x.reshape(-1, 1))
    # The finite difference uses each point's coordinate magnitude and the data
    # span, preserving units even for very small or very large x coordinates.
    h = np.maximum(np.abs(x) * 1e-7, (float(x.max()) - float(x.min())) * 1e-5)
    x_error_points = ex > 0
    plus = np.ascontiguousarray((x[x_error_points] + h[x_error_points]).reshape(-1, 1))
    minus = np.ascontiguousarray((x[x_error_points] - h[x_error_points]).reshape(-1, 1))
    with_x_errors = bool(np.any(x_error_points))
    # A change of Y units should not stop local refinement merely because all
    # unweighted residuals are numerically tiny. This common scalar affects only
    # optimizer tolerances; the score sent to the user remains the raw SSE.
    optimization_scale = config.get("optimization_scale") or (1.0 if np.any(ey > 0) else max(
        float(np.std(y)), float(np.max(np.abs(y))) * .001, np.finfo(float).tiny ** .25))
    # Linear coordinates preserve centers. asinh coordinates let other scales
    # span orders of magnitude, include zero and negative values, and remain
    # well conditioned for bounded local least squares.
    scales = np.array([max(abs(hint["scale"]), 1e-150) for hint in config["hints"]])[free]
    linear = np.array([hint["role"] in ("center", "phase", "fraction") for hint in config["hints"]])[free]
    lower, upper = bounds[free, 0], bounds[free, 1]
    def warp(values):
        scaled = np.asarray(values) / scales
        return np.where(linear, scaled, np.arcsinh(scaled))
    warped_lower, warped_upper = warp(lower), warp(upper)
    def encode(values):
        return 2 * (warp(np.asarray(values)[free]) - warped_lower) / (warped_upper - warped_lower) - 1
    def decode(z):
        warped = warped_lower + (np.asarray(z) + 1) * .5 * (warped_upper - warped_lower)
        values = bounds[:, 0].copy()
        with np.errstate(over="ignore"):
            values[free] = np.where(linear, warped, np.sinh(warped)) * scales
        return np.clip(values, bounds[:, 0], bounds[:, 1])
    def evaluate(values, points=xgrid):
        if "evaluate" in config:
            return config["evaluate"](values)
        # Current ROOT versions evaluate an entire NumPy dataset in C++ here.
        return np.asarray(function.EvalPar(points, np.ascontiguousarray(values)), dtype=float).reshape(-1)
    def report(force=False):
        nonlocal last_progress
        now = time.monotonic()
        if progress_callback and (force or now - last_progress >= .25):
            progress_callback(dict(phase=phase, evaluations=evaluations, best_score=best_score,
                                   elapsed_seconds=round(now - started, 2)))
            last_progress = now
    def residual(z):
        nonlocal evaluations, best_score, best_values
        if time.monotonic() >= deadline:
            raise _TimeLimit()
        values = decode(z)
        evaluations += 1
        with np.errstate(all="ignore"):
            predicted = evaluate(values)
            if "residual" in config:
                result = config["residual"](values, predicted)
                variance = np.zeros(len(result))
            else:
                variance = ey ** 2
                if with_x_errors:
                    derivative = np.zeros(len(x))
                    derivative[x_error_points] = (evaluate(values, plus) - evaluate(values, minus)) / (2 * h[x_error_points])
                    variance = variance + (ex * derivative) ** 2
                errors = np.where(variance > 0, np.sqrt(variance), 1)
                result = (predicted - y) / errors
            finite = (np.isfinite(predicted).all() and np.isfinite(variance).all()
                      and np.isfinite(result).all() and np.max(np.abs(result)) < 1e45)
            score = float(np.dot(result, result)) if finite else INVALID_SCORE
        if finite and (best_score is None or score < best_score):
            best_score, best_values = score, values.copy()
        report()
        return result / optimization_scale if finite else np.full(config.get("n_observations", len(y)), math.sqrt(INVALID_SCORE / config.get("n_observations", len(y))))
    def objective(z):
        result = residual(z)
        return float(np.dot(result, result))
    def refine(z, max_evaluations=120):
        try:
            fitted = least_squares(residual, np.clip(z, -1 + 1e-12, 1 - 1e-12),
                                   bounds=(-np.ones(dimensions), np.ones(dimensions)),
                                   max_nfev=max_evaluations, ftol=1e-8, xtol=1e-8, gtol=1e-8)
            return fitted.x, float(np.dot(fitted.fun, fitted.fun))
        except (ValueError, FloatingPointError, np.linalg.LinAlgError):
            return z, objective(z)
    initial_score = None
    local_candidates = []
    def nearly_exact():
        return best_score is not None and math.sqrt(best_score) / optimization_scale < 1e-8
    try:
        start_z = encode(initial)
        objective(start_z)
        initial_score = best_score
        if dimensions:
            hinted = np.array([hint["initial"] for hint in config["hints"]])
            hinted = np.clip(hinted, bounds[:, 0], bounds[:, 1])
            seeds = [start_z, encode(hinted)]
            # Give each discovered oscillation a fair local trial. This generic
            # frequency hint works for nested/damped/custom trigonometric models.
            for frequency in config["peaks"][:5]:
                candidate = hinted.copy()
                for i, hint in enumerate(config["hints"]):
                    if hint["role"] == "frequency":
                        candidate[i] = frequency / hint["multiplier"]
                seeds.append(encode(np.clip(candidate, bounds[:, 0], bounds[:, 1])))
            phase = "Refining data-based estimates"
            for z in seeds:
                local_candidates.append(refine(z, 100))
                if nearly_exact():
                    break
            # Diverse bounded populations plus repeated local refinement can
            # cross the many local minima of oscillations and custom formulas.
            phase = "Searching alternative starting values"
            population_size = max(24, 10 * dimensions)
            rounds = 0
            while time.monotonic() < deadline and not nearly_exact():
                population = rng.uniform(-1, 1, (population_size, dimensions))
                ranked = sorted(local_candidates, key=lambda item: item[1])
                for i, (z, _) in enumerate(ranked[:min(8, population_size // 4)]):
                    population[i] = np.clip(z, -1, 1)
                if best_values is not None:
                    best_z = encode(best_values)
                    population[0] = np.clip(best_z, -1, 1)
                    count = population_size // 3
                    spread = (.05, .2, .6)[rounds % 3]
                    population[-count:] = np.clip(best_z + rng.normal(0, spread, (count, dimensions)), -1, 1)
                evolved = differential_evolution(objective, [(-1, 1)] * dimensions,
                    init=population, maxiter=20, popsize=10, seed=rng,
                    polish=False, tol=0, atol=0, mutation=(.5, 1.5), recombination=.85)
                phase = "Refining promising candidates"
                ordering = np.argsort(evolved.population_energies)
                diverse = []
                for index in ordering:
                    z = evolved.population[index]
                    if all(np.linalg.norm(z - previous) > .08 for previous in diverse):
                        diverse.append(z)
                    if len(diverse) == 5:
                        break
                local_candidates.extend(refine(z, 160) for z in diverse)
                local_candidates = sorted(local_candidates, key=lambda item: item[1])[:12]
                rounds += 1
                phase = "Searching alternative starting values"
        else:
            phase = "Checked fixed parameters"
    except _TimeLimit:
        timed_out = True
    if best_values is None or best_score is None:
        raise ValueError("No finite curve was found. Adjust the parameter ranges or starting values, then try again.")
    warnings = list(config["warnings"]) + config.get("notes", [])
    if timed_out:
        warnings.append("The time limit was reached; these are the best values found so far.")
    if dimensions:
        position = (best_values[free] - lower) / (upper - lower)
        at_edge = np.flatnonzero(free)[(position < 1e-4) | (position > 1 - 1e-4)]
        if len(at_edge):
            warnings.append("Values near a search limit: " + ", ".join(config["names"][i] for i in at_edge) + ". Consider wider ranges.")
        # A numerical sensitivity check is a diagnostic, not a covariance or an
        # identifiability proof. It catches unused/degenerate parameters (a*b*x).
        z = encode(best_values)
        columns = []
        for i in range(dimensions):
            offset = np.zeros(dimensions)
            offset[i] = 1e-5
            with np.errstate(all="ignore"):
                columns.append((evaluate(decode(z + offset)) - evaluate(decode(z - offset))) / 2e-5)
        jacobian = np.asarray(columns).T
        if np.isfinite(jacobian).all():
            norms = np.linalg.norm(jacobian, axis=0)
            normalized = jacobian / np.where(norms > 0, norms, 1)
            if np.linalg.matrix_rank(normalized, tol=1e-5) < dimensions:
                warnings.append("Some parameters have indistinguishable or very weak effects on these data. Their individual values may not be determined.")
    if "preview" in config:
        curve = config["preview"](best_values)
    else:
        preview_x = np.linspace(*config["limits"], 301)
        with np.errstate(all="ignore"):
            preview_y = evaluate(best_values, preview_x.reshape(-1, 1))
        if not np.isfinite(preview_y).all():
            raise ValueError("The best candidate is undefined between data points. Narrow the fit range or adjust parameter bounds.")
        curve = dict(x=preview_x.tolist(), y=preview_y.tolist())
    if initial_score is not None and best_score >= initial_score * (1 - 1e-8):
        warnings.append("The search did not improve on the starting values.")
    warnings.append("These are starting values, not a validated fit. Apply them and run Fit to evaluate convergence and uncertainties.")
    phase = "Search complete"
    report(force=True)
    return dict(values=best_values.tolist(), score=float(best_score), initial_score=initial_score,
                evaluations=evaluations, elapsed_seconds=round(time.monotonic() - started, 2),
                n_points=len(x), free_parameters=dimensions, seed=seed, timed_out=timed_out,
                warnings=warnings, curve=curve, analysis_type=payload.get("analysis_type", "xy"),
                score_description=config.get("score_description", "Sum of squared residuals, with X/Y uncertainties through effective variance when supplied."))
