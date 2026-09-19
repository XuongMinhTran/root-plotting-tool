"""
simultaneous_reference.py — a ROOT-free reference for simultaneous chi-square fits.

Used by simultaneous_test.py to check the ROOT result against an independent
implementation: synthetic datasets with known true values, plus a plain
Levenberg-Marquardt minimizer (NumPy only) of the summed chi-square

    chi2(p) = sum over datasets d, points i of ((y_i - f_d(x_i; p_d)) / ey_i)^2,

where p_d is dataset d's slice of the global parameter vector p. The covariance
is the Gauss-Newton estimate (J^T W J)^-1 at the minimum. No X uncertainties
here: the X-uncertainty check in simultaneous_test.py compares ROOT with ROOT.

Runs on its own as a self-check:   python3 simultaneous_reference.py
"""

import math

import numpy as np


def decay(x, p):
    return p[0] * np.exp(-x / p[1]) + p[2]


def synthetic_decays(seed=20260926):
    """Two decay runs with different amplitudes and backgrounds and one true time constant.
    The default seed gives a typical realization (shared-fit pull of the time constant -0.35);
    over the seeds 20260919-20260939, 14 of 21 realizations fall within one standard uncertainty."""
    rng = np.random.default_rng(seed)
    tau = 2.5
    x = np.linspace(0, 10, 21)
    runs = []
    for amplitude, background, sigma in ((100.0, 5.0, 3.0), (40.0, 2.0, 1.5)):
        truth = decay(x, (amplitude, tau, background))
        y = truth + rng.normal(0, sigma, len(x))
        runs.append(dict(x=x.copy(), y=y, ey=np.full(len(x), sigma), truth=(amplitude, tau, background)))
    return tau, runs


def lm_fit(models, start, fixed=(), iterations=200):
    """Levenberg-Marquardt for the summed chi-square.

    models: list of (x, y, ey, f, index) where f(x, local_params) is the model and
            index maps local parameter j to global parameter index[j].
    start:  initial global parameters. fixed: global indices held constant.
    Returns (params, covariance, chi2, per_dataset_chi2). Rows/columns of fixed
    parameters in the covariance are zero.
    """
    p = np.array(start, dtype=float)
    free = [i for i in range(len(p)) if i not in set(fixed)]

    def residuals(q):
        return np.concatenate([(y - f(x, q[list(index)])) / ey for x, y, ey, f, index in models])

    def jacobian(q):
        r0 = residuals(q)
        cols = []
        for i in free:
            h = 1e-6 * max(1.0, abs(q[i]))
            qp, qm = q.copy(), q.copy()
            qp[i] += h
            qm[i] -= h
            cols.append((residuals(qp) - residuals(qm)) / (2 * h))
        return r0, np.array(cols).T

    lam = 1e-3
    r, J = jacobian(p)
    chi2 = float(r @ r)
    for _ in range(iterations):
        A = J.T @ J
        g = J.T @ r
        step = np.linalg.solve(A + lam * np.diag(np.diag(A)), -g)
        trial = p.copy()
        trial[free] += step
        rt = residuals(trial)
        chi2_t = float(rt @ rt)
        if chi2_t < chi2:
            p, chi2 = trial, chi2_t
            lam = max(lam / 10, 1e-12)
            r, J = jacobian(p)
            if abs(step).max() < 1e-10:
                break
        else:
            lam *= 10
            if lam > 1e12:
                break
    cov_free = np.linalg.inv(J.T @ J)
    cov = np.zeros((len(p), len(p)))
    for a, i in enumerate(free):
        for b, k in enumerate(free):
            cov[i, k] = cov_free[a, b]
    parts = [float(np.sum(((y - f(x, p[list(index)])) / ey) ** 2)) for x, y, ey, f, index in models]
    return p, cov, chi2, parts


def reference_shared_fit(runs):
    """Both runs with a shared tau: global vector (tau, A1, B1, A2, B2)."""
    models = [(r["x"], r["y"], r["ey"], lambda x, q: decay(x, (q[0], q[1], q[2])), (1 + 2 * k, 0, 2 + 2 * k)) for k, r in enumerate(runs)]
    start = [2.0, runs[0]["y"][0], runs[0]["y"][-1], runs[1]["y"][0], runs[1]["y"][-1]]
    return lm_fit(models, start)


def reference_single_fit(run):
    models = [(run["x"], run["y"], run["ey"], lambda x, q: decay(x, (q[0], q[1], q[2])), (0, 1, 2))]
    return lm_fit(models, [run["y"][0], 2.0, run["y"][-1]])


def main():
    tau, runs = synthetic_decays()
    p, cov, chi2, parts = reference_shared_fit(runs)
    err = math.sqrt(cov[0, 0])
    print(f"shared tau = {p[0]:.4f} +/- {err:.4f}   (true {tau}),  chi2 = {chi2:.2f} for {sum(len(r['x']) for r in runs) - 5} ndf, parts = {[round(c, 2) for c in parts]}")
    singles = [reference_single_fit(r) for r in runs]
    for k, (q, c, chi2_k, _) in enumerate(singles):
        print(f"run {k + 1} alone: tau = {q[1]:.4f} +/- {math.sqrt(c[1, 1]):.4f},  chi2 = {chi2_k:.2f}")
    assert abs(p[0] - tau) < 2 * err, "shared tau is not within two standard uncertainties of the truth"
    assert all(err < math.sqrt(c[1, 1]) for _, c, _, _ in singles), "the shared uncertainty should be smaller than each single-run uncertainty"
    print("OK: reference implementation recovers the shared time constant with a smaller uncertainty than either run alone.")


if __name__ == "__main__":
    main()
