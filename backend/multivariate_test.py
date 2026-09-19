"""
multivariate_test.py — check the ROOT multivariate fit against reference numbers.

Runs inside the ROOT container (needs ROOT + numpy, not scipy):

    ./root-run python3 backend/multivariate_test.py
    # or:  docker run --rm --platform linux/amd64 -v "$PWD":/work -w /work/backend \
    #          rootfit-backend python3 multivariate_test.py

The cases in multivariate_cases.json were fitted offline by
multivariate_reference.py (numpy/scipy). Here we refit them with ROOT and
require the parameters to agree with both the reference and the true values
that generated the data, and the effective-variance path (input errors) to work.
"""

import json
import os

import numpy as np

import multivariate_fit as mv

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = json.load(open(os.path.join(HERE, "multivariate_cases.json")))


def check(name, got, ref_params, true_params, chi2_ndf_ref):
    gp = [p["value"] for p in got["params"]]
    # ROOT vs reference minimiser: parameters must line up tightly.
    assert np.allclose(gp, ref_params, rtol=2e-3, atol=2e-3), \
        f"{name}: ROOT params {gp} != reference {ref_params}"
    # And both must recover the truth that generated the data.
    assert np.allclose(gp, true_params, rtol=0.05, atol=0.05), \
        f"{name}: ROOT params {gp} != truth {true_params}"
    assert got["chi2_ndf"] is not None and got["chi2_ndf"] < 3, \
        f"{name}: chi2/ndf {got['chi2_ndf']} unreasonable"
    assert got["canvas_json"] is not None, f"{name}: no plot produced"
    assert got["converged"], f"{name}: did not converge ({got['status_message']})"
    print(f"  {name:26s} params={[round(v,4) for v in gp]}  "
          f"chi2/ndf={got['chi2_ndf']:.3f}  (ref {chi2_ndf_ref:.3f})  OK")


def main():
    print("Multivariate ROOT fit vs reference:")
    for c in CASES:
        got = mv.run_multivariate(
            c["inputs"], c["outputs"], c["models"],
            output_errors=c.get("output_errors"),
            param_guesses=c.get("guesses"),
        )
        check(c["name"], got, c["reference"]["params"], c["true"],
              c["reference"]["chi2_ndf"])

    # Extra: effective variance with input errors (R^1 -> R^1 line).
    xx = np.linspace(0, 10, 40)
    yy = 3.0 * xx + 1.0
    got = mv.run_multivariate([list(xx)], [list(yy)], ["[0]*x0 + [1]"],
                              input_errors=[[0.1]], output_errors=[[0.2]],
                              param_guesses=[1, 0])
    gp = [p["value"] for p in got["params"]]
    assert np.allclose(gp, [3.0, 1.0], atol=0.05), f"effective-variance params off: {gp}"
    print(f"  {'effective variance':26s} params={[round(v,4) for v in gp]}  OK")

    # Extra: shared parameter really is shared (one global for two outputs).
    x0 = np.linspace(0, 2, 25)
    got = mv.run_multivariate([list(x0)], [list(2 * x0), list(2 * x0 + 5)],
                              ["[0]*x0", "[0]*x0 + [1]"], param_guesses=[1, 1])
    gp = [p["value"] for p in got["params"]]
    assert len(gp) == 2 and np.isclose(gp[0], 2.0, atol=1e-3) and np.isclose(gp[1], 5.0, atol=1e-3), \
        f"shared-parameter case off: {gp}"
    print(f"  {'shared parameter':26s} params={[round(v,4) for v in gp]}  OK")

    print("\nOK: multivariate ROOT fit matches the reference and recovers truth.")


if __name__ == "__main__":
    main()
