"""
multivariate_reference.py — a dependency-light reference for the general
R^n -> R^m least-squares fit, written against numpy/scipy so it can run and be
checked outside the ROOT container. multivariate_fit.py (ROOT) must agree with
this to a tolerance; multivariate_test.py enforces that.

Model
-----
N measured points. Point i has an input vector x_i in R^n and an output vector
y_i in R^m. Output k of point i has uncertainty sy[i,k]; input d has sx[i,d].
There are m component models f_k(x; p) sharing ONE global parameter vector
p in R^P. Sharing is by parameter index: a parameter token [j] means p[j]
wherever it appears, in any output's formula, so a [j] used by two outputs is
shared and a [j] used by one output is that output's own.

Objective (effective-variance chi-square, ROOT's convention)
------------------------------------------------------------
    s_eff[i,k]^2 = sy[i,k]^2 + sum_d ( df_k/dx_d (x_i; p) * sx[i,d] )^2
    r[i,k]       = (y[i,k] - f_k(x_i; p)) / s_eff[i,k]
    chi2(p)      = sum_{i,k} r[i,k]^2
A point/output with s_eff == 0 gets weight 1 (unweighted), like TGraph::Fit.
"""

import re
import numpy as np
from scipy.optimize import least_squares

# ---- formula string (UI syntax) -> callable ------------------------------
# UI syntax: inputs are x0, x1, ... ; parameters are [0], [1], ...
# We translate to a numpy-evaluated lambda f(x, p) where x, p are 1-D arrays.
_FUNCS = {
    "exp": np.exp, "log": np.log, "log10": np.log10, "sqrt": np.sqrt,
    "sin": np.sin, "cos": np.cos, "tan": np.tan, "abs": np.abs,
    "sinh": np.sinh, "cosh": np.cosh, "tanh": np.tanh,
    "asin": np.arcsin, "acos": np.arccos, "atan": np.arctan,
    "pow": lambda a, b: np.power(a, b), "pi": np.pi, "e": np.e,
}


def compile_model(formula):
    src = formula
    src = src.replace("TMath::Pi()", "pi").replace("TMath::Pi", "pi")
    src = re.sub(r"TMath::([A-Za-z0-9_]+)", lambda m: m.group(1).lower(), src)
    src = re.sub(r"\[(\d+)\]", r"p[\1]", src)          # [j] -> p[j]
    src = re.sub(r"\bx(\d+)\b", r"x[\1]", src)         # xd  -> x[d]
    code = compile(src, "<model>", "eval")

    def f(x, p):
        return eval(code, {"__builtins__": {}}, {**_FUNCS, "x": x, "p": p})
    return f


def n_params(models):
    """Highest parameter index referenced across all output formulas, + 1."""
    hi = -1
    for m in models:
        for tok in re.findall(r"\[(\d+)\]", m):
            hi = max(hi, int(tok))
    return hi + 1


def _broadcast_err(col, N):
    a = np.asarray(col, dtype=float) if col is not None else np.zeros(0)
    if a.size == 0:
        return np.zeros(N)
    if a.size == 1:
        return np.full(N, a[0])
    return a


def run_reference(inputs, outputs, models,
                  input_errors=None, output_errors=None,
                  guesses=None, input_ranges=None):
    """
    inputs        : list of n columns (each length N)
    outputs       : list of m columns (each length N)
    models        : list of m formula strings (UI syntax)
    input_errors  : list of n error columns ([]/one/N), or None
    output_errors : list of m error columns ([]/one/N), or None
    guesses       : list of P starting values, or None
    input_ranges  : list of n (lo, hi) or None, selecting points (AND across dims)
    """
    X = np.array([np.asarray(c, float) for c in inputs])   # (n, N)
    Y = np.array([np.asarray(c, float) for c in outputs])  # (m, N)
    n, N = X.shape
    m = Y.shape[0]
    P = n_params(models)
    funcs = [compile_model(s) for s in models]

    SX = np.array([_broadcast_err(input_errors[d] if input_errors else None, N) for d in range(n)])
    SY = np.array([_broadcast_err(output_errors[k] if output_errors else None, N) for k in range(m)])

    # fit-range mask: keep points inside every provided per-input range
    mask = np.ones(N, dtype=bool)
    if input_ranges:
        for d, rng in enumerate(input_ranges):
            if rng:
                lo, hi = float(rng[0]), float(rng[1])
                mask &= (X[d] >= lo) & (X[d] <= hi)
    idx = np.where(mask)[0]
    Xm, Ym, SXm, SYm = X[:, idx], Y[:, idx], SX[:, idx], SY[:, idx]
    Nm = idx.size

    def f_k(k, Xcols, p):
        xv = [Xcols[d] for d in range(n)]
        return np.asarray(funcs[k](xv, p), dtype=float)

    def s_eff(k, Xcols, p):
        var = SYm[k] ** 2
        if (SXm > 0).any():
            for d in range(n):
                if (SXm[d] > 0).any():
                    h = np.where(np.abs(Xcols[d]) > 0, np.abs(Xcols[d]) * 1e-6, 1e-6)
                    Xp = [Xcols[dd].copy() for dd in range(n)]
                    Xm2 = [Xcols[dd].copy() for dd in range(n)]
                    Xp[d] = Xcols[d] + h
                    Xm2[d] = Xcols[d] - h
                    deriv = (f_k(k, Xp, p) - f_k(k, Xm2, p)) / (2 * h)
                    var = var + (deriv * SXm[d]) ** 2
        s = np.sqrt(var)
        s[s == 0] = 1.0
        return s

    def residuals(p):
        r = []
        Xcols = [Xm[d] for d in range(n)]
        for k in range(m):
            pred = f_k(k, Xcols, p)
            r.append((Ym[k] - pred) / s_eff(k, Xcols, p))
        return np.concatenate(r)

    p0 = np.array(guesses, float) if guesses is not None else np.ones(P)
    sol = least_squares(residuals, p0, method="lm", max_nfev=10000)
    p = sol.x
    J = sol.jac
    chi2 = float(np.sum(sol.fun ** 2))
    ndf = Nm * m - P
    try:
        cov = np.linalg.inv(J.T @ J)
        perr = np.sqrt(np.diag(cov))
    except np.linalg.LinAlgError:
        cov = np.full((P, P), np.nan)
        perr = np.full(P, np.nan)
    return {
        "params": [float(v) for v in p],
        "errors": [float(v) for v in perr],
        "chi2": chi2,
        "ndf": int(ndf),
        "chi2_ndf": chi2 / ndf if ndf > 0 else None,
        "n_points": int(Nm),
        "n_inputs": n, "n_outputs": m, "n_par": P,
        "covariance": cov.tolist(),
    }


# ----------------------------- self-check ---------------------------------
if __name__ == "__main__":
    rng = np.random.default_rng(1)

    # Case A: R^3 -> R, linear.  f = a*x0 + b*x1 + c*x2 + d
    N = 60
    x0 = rng.uniform(-2, 2, N); x1 = rng.uniform(-2, 2, N); x2 = rng.uniform(0, 4, N)
    true = [1.5, -0.8, 0.4, 2.0]
    sigma = 0.05
    y = true[0]*x0 + true[1]*x1 + true[2]*x2 + true[3] + rng.normal(0, sigma, N)
    A = run_reference([x0, x1, x2], [y],
                      ["[0]*x0 + [1]*x1 + [2]*x2 + [3]"],
                      output_errors=[[sigma]],
                      guesses=[1, 1, 1, 1])
    print("Case A  R^3->R linear")
    print("  true  ", true)
    print("  fit   ", [round(v, 4) for v in A["params"]])
    print("  err   ", [round(v, 4) for v in A["errors"]])
    print("  chi2/ndf=%.3f  ndf=%d" % (A["chi2_ndf"], A["ndf"]))
    assert np.allclose(A["params"], true, atol=6*sigma), "Case A params off"

    # Case B: R^2 -> R^3, shared params p0,p1 across out0/out1; p2 only out2.
    N = 80
    x0 = rng.uniform(0, 3, N); x1 = rng.uniform(-1, 2, N)
    tp = [2.0, -1.3, 0.7]
    s = 0.04
    y0 = tp[0]*x0 + tp[1]*x1 + rng.normal(0, s, N)
    y1 = tp[0]*x0 - tp[1]*x1 + rng.normal(0, s, N)
    y2 = tp[2]*x0*x1 + rng.normal(0, s, N)
    B = run_reference([x0, x1], [y0, y1, y2],
                      ["[0]*x0 + [1]*x1", "[0]*x0 - [1]*x1", "[2]*x0*x1"],
                      output_errors=[[s], [s], [s]],
                      guesses=[1, 1, 1])
    print("Case B  R^2->R^3 shared params")
    print("  true  ", tp)
    print("  fit   ", [round(v, 4) for v in B["params"]])
    print("  err   ", [round(v, 4) for v in B["errors"]])
    print("  chi2/ndf=%.3f  ndf=%d  npar=%d" % (B["chi2_ndf"], B["ndf"], B["n_par"]))
    assert np.allclose(B["params"], tp, atol=6*s), "Case B params off"

    # Case C: effective-variance path with input errors (R^1 -> R^1, slope).
    N = 50
    xx = np.linspace(0, 10, N)
    tc = [3.0, 1.0]
    sx, sy = 0.1, 0.2
    yy = tc[0]*xx + tc[1] + rng.normal(0, sy, N)
    C = run_reference([xx], [yy], ["[0]*x0 + [1]"],
                      input_errors=[[sx]], output_errors=[[sy]], guesses=[1, 0])
    print("Case C  effective variance (input errors)")
    print("  true  ", tc, " fit ", [round(v, 4) for v in C["params"]],
          " err ", [round(v, 4) for v in C["errors"]])
    assert np.allclose(C["params"], tc, atol=0.15), "Case C params off"

    print("\nALL REFERENCE CASES PASSED")
