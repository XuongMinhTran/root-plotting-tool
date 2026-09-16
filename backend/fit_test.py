"""
fit_test.py — quick self-test of fit.py that needs ROOT but not Flask.

Run from the repo root, inside the ROOT container:
    ./root-run python3 backend/fit_test.py

It fits a straight line to a small dataset with y errors and compares ROOT's
answer with the exact weighted-least-squares solution (for a straight line the
chi^2 minimum can be written down in closed form, so we know what to expect).
The reference numbers live in tests/linear_reference.json.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import fit  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "..", "tests", "linear_reference.json")


def close(a, b, tol):
    return abs(a - b) <= tol * max(1.0, abs(b))


def main():
    with open(REF) as f:
        ref = json.load(f)

    d = ref["data"]
    out = fit.run_fit(d["x"], d["y"], d.get("ex"), d.get("ey"),
                      formula=ref["formula"],
                      par_names=ref["param_names"], par_guesses=ref["initial_guesses"],
                      title="self-test", x_title="x", y_title="y")

    print(f"status   = {out['status']}  ({out['status_message']})")
    print(f"chi2/ndf = {out['chi2']:.4f} / {out['ndf']}   prob = {out['prob']:.4f}")
    for p in out["params"]:
        print(f"{p['name']:>10s} = {p['value']:.5f} +/- {p['error']:.5f}")
    print(f"canvas_json: {out['canvas_json']['_typename']} with "
          f"{len(out['canvas_json']['fPrimitives']['arr'])} primitives")

    failures = []
    exp = ref["expected"]
    for got, want in zip(out["params"], exp["params"]):
        if not close(got["value"], want["value"], 1e-3):
            failures.append(f"{want['name']} value {got['value']} != {want['value']}")
        if not close(got["error"], want["error"], 2e-2):
            failures.append(f"{want['name']} error {got['error']} != {want['error']}")
    if not close(out["chi2"], exp["chi2"], 1e-3):
        failures.append(f"chi2 {out['chi2']} != {exp['chi2']}")
    if out["ndf"] != exp["ndf"]:
        failures.append(f"ndf {out['ndf']} != {exp['ndf']}")
    if out["status"] != 0:
        failures.append(f"status {out['status']} != 0")

    if failures:
        print("\nFAILED:")
        for f_ in failures:
            print("  -", f_)
        sys.exit(1)
    print("\nOK: ROOT agrees with the closed-form weighted least squares solution.")


if __name__ == "__main__":
    main()
