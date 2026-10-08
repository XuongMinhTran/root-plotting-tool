"""Numerical and HTTP regression checks for general starting-value search."""

from pathlib import Path
import sys
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app import app
from parameter_search import prepare, search
from parameter_search import _TimeLimit
from search_jobs import manager


def line_payload():
    x = np.linspace(-2, 3, 51)
    noise = np.random.default_rng(31).normal(0, .1, len(x))
    return dict(x=x.tolist(), y=(3 * x + 5 + noise).tolist(), ey=[.1],
                formula="[0]*x+[1]", param_names=["slope", "intercept"],
                initial_guesses=[1, 0], time_budget=1, seed=31)


class NumericalSearchTests(unittest.TestCase):
    def test_noisy_line_improves_bad_guesses(self):
        payload = line_payload()
        result = search(payload)
        expected = np.polyfit(payload["x"], payload["y"], 1)
        np.testing.assert_allclose(result["values"], expected, atol=.002)
        self.assertLess(result["score"], result["initial_score"] / 100)
        self.assertLess(result["score"] / len(payload["x"]), 2)
        self.assertTrue(np.isfinite(result["curve"]["y"]).all())

    def test_custom_formula_with_very_different_parameter_scales(self):
        x = np.linspace(1e-6, 5e-6, 70)
        y = 8e5 * np.exp(-x / 1.2e-6) + 3000
        result = search(dict(x=x.tolist(), y=y.tolist(), formula="[0]*exp(-x/[1])+[2]",
                             bounds=[[0, 2e6], [1e-7, 1e-5], [0, 10000]],
                             time_budget=2, seed=5))
        self.assertLess(np.sqrt(result["score"] / len(x)), np.max(y) * .002)

    def test_custom_rational_and_trigonometric_expression(self):
        x = np.linspace(.1, 5, 70)
        y = 3.5 * x / (1 + .8 * x) + .2 * np.sin(x)
        result = search(dict(x=x.tolist(), y=y.tolist(), formula="[0]*x/(1+[1]*x)+[2]*sin(x)",
                             bounds=[[-20, 20], [.01, 3], [-2, 2]], time_budget=2, seed=22))
        self.assertLess(result["score"], .001)
        np.testing.assert_allclose(result["values"], [3.5, .8, .2], atol=.01)

    def test_fixed_parameters_use_x_and_y_errors_and_selected_range(self):
        payload = dict(x=[0, 1, 2, 10], y=[1.1, 2.8, 5.3, 1e10],
                       ex=[.1, .1, 0, 0], ey=[.5, .5, 0, 0], formula="[0]*x+[1]",
                       bounds=[[2, 2], [1, 1]], x_range=[0, 2], time_budget=1)
        result = search(payload)
        self.assertEqual(result["values"], [2, 1])
        self.assertEqual(result["n_points"], 3)
        self.assertAlmostEqual(result["score"], (.1 ** 2 + .2 ** 2) / (.5 ** 2 + .2 ** 2) + .3 ** 2, places=7)

    def test_undefined_candidates_fail_without_dropping_measurements(self):
        with self.assertRaisesRegex(ValueError, "No finite curve"):
            search(dict(x=[0, 1, 2], y=[1, 2, 3], formula="sqrt(x-[0])",
                        bounds=[[3, 4]], time_budget=1))

    def test_redundant_parameters_are_flagged(self):
        x = np.linspace(0, 2, 30)
        result = search(dict(x=x.tolist(), y=(6 * x).tolist(), formula="[0]*[1]*x",
                             initial_guesses=[2, 3], bounds=[[.1, 10], [.1, 10]], time_budget=1))
        self.assertTrue(any("indistinguishable" in warning for warning in result["warnings"]))

    def test_invalid_penalty_preserves_ranking_for_tiny_y_units(self):
        def no_refinement(fun, z, **kwargs):
            result = fun(z)
            return SimpleNamespace(x=z, fun=result, success=False)

        def check_ranking(objective, bounds, **kwargs):
            valid_score = objective(np.array([1.]))
            invalid_score = objective(np.array([-1.]))
            self.assertTrue(np.isfinite([valid_score, invalid_score]).all())
            self.assertGreater(invalid_score, valid_score)
            raise _TimeLimit()

        with patch('scipy.optimize.least_squares', side_effect=no_refinement), \
                patch('scipy.optimize.differential_evolution', side_effect=check_ranking):
            result = search(dict(x=[0, 1, 2], y=[1e-60] * 3, formula='sqrt([0])',
                                 bounds=[[-1, 1]], initial_guesses=[-1], time_budget=1))
        self.assertGreaterEqual(result['values'][0], 0)
        self.assertTrue(np.isfinite(result['curve']['y']).all())

    def test_local_refinements_bound_actual_residual_calls_and_keep_results(self):
        calls = []
        def excessive_jacobian_work(fun, z, **kwargs):
            completed = 0
            try:
                for _ in range(1000):
                    result = fun(z)
                    completed += 1
            finally:
                calls.append(completed)
            return SimpleNamespace(x=z, fun=result, success=False)

        # Freeze time to exercise the residual-call limit independently of the
        # clock. An optimizer requesting excess Jacobian work must still stop.
        with patch('parameter_search.time.monotonic', return_value=0.), \
                patch('scipy.optimize.least_squares', side_effect=excessive_jacobian_work), \
                patch('scipy.optimize.differential_evolution', side_effect=_TimeLimit):
            result = search(dict(x=[0, 1, 2], y=[1, 2, 1], formula='[0]', time_budget=1))
        self.assertTrue(calls)
        self.assertTrue(all(0 < count < 300 for count in calls))
        self.assertTrue(np.isfinite(result['score']))
        self.assertEqual(result['evaluations'], sum(calls) + 1)

    def test_optional_stalled_stop_retains_noisy_line_solution(self):
        payload = line_payload()
        payload.update(time_budget=5, stop_when_stalled=True)
        result = search(payload)
        expected = np.polyfit(payload['x'], payload['y'], 1)
        np.testing.assert_allclose(result['values'], expected, atol=.002)
        self.assertFalse(result['timed_out'])
        self.assertTrue(any('without meaningful improvement' in note for note in result['warnings']))

    def test_cached_y_errors_preserve_zero_uncertainty_convention(self):
        result = search(dict(x=[0, 1, 2], y=[1.1, 2.8, 5.3], ey=[.5, 0, 2],
                             formula='[0]*x+[1]', bounds=[[2, 2], [1, 1]], time_budget=1))
        self.assertAlmostEqual(result['score'], .1**2 / .5**2 + .2**2 + .3**2 / 2**2, places=7)

    def test_constant_and_named_formulas_can_be_prepared(self):
        for formula in ("[0]", "pol0", "gaus", "gaus(0)+pol1(3)"):
            with self.subTest(formula=formula):
                payload = line_payload()
                payload.update(formula=formula, initial_guesses=[], param_names=[])
                result = prepare(payload)
                self.assertGreater(len(result["parameters"]), 0)
                self.assertTrue(all(np.isfinite([p["initial"], p["lower"], p["upper"]]).all()
                                    for p in result["parameters"]))

    def test_nine_parameter_library_model_from_generic_guesses(self):
        # An independent shifted experiment with changing contrast and count
        # noise. Fit the curve rather than asserting a unique fringe origin:
        # shifting that parameter by whole periods gives equivalent solutions.
        import json
        import re
        source = (Path(__file__).resolve().parents[1] / "frontend/model-library.js").read_text()
        library = json.loads(re.search(r"const DATA = (.*?);\s*const norm", source, re.S).group(1))
        model = next(m for m in library["models"] if m["name"] == "Double-slit (Gaussian fringe visibility)")
        x = np.linspace(3, 8, 101)
        envelope = np.sinc(.87 * (x - 5.3) / np.pi) ** 2
        expected = 90 + 11000 * envelope * (1 + .7 * np.exp(-((x - 6) / 3.1) ** 2)
                                           * np.cos(2 * 4.2 * (x - 5.4)))
        errors = np.sqrt(expected)
        measured = expected + np.random.default_rng(123).normal(0, errors)
        result = search(dict(x=x.tolist(), y=measured.tolist(), ey=errors.tolist(),
                             formula=model["formula"], param_names=model["params"],
                             initial_guesses=model["guesses"], time_budget=20, seed=1729))
        self.assertLess(result["score"] / len(x), 3)
        self.assertLess(result["score"], result["initial_score"] / 100)
        self.assertTrue(np.isfinite(result["curve"]["y"]).all())


class SearchEndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_invalid_requests_do_not_start_workers(self):
        for change in ({"formula": "system(x)"}, {"x": [0, 1]}, {"ey": [-1]},
                       {"time_budget": 301}, {"time_budget": True}, {"seed": -1},
                       {"stop_when_stalled": "true"},
                       {"bounds": [[0, 1]]}, {"bounds": [[5, 2], [0, 3]]},
                       {"bounds": [[0, float("inf")], [0, 3]]},
                       {"x_range": [2, 1]}, {"analysis_type": "histogram"}):
            with self.subTest(change=change):
                payload = line_payload()
                payload.update(change)
                response = self.client.post("/parameter-search", json=payload)
                self.assertEqual(response.status_code, 400, response.get_json())
                self.assertIn("error", response.get_json())

    def test_prepare_search_poll_result_and_expired_id(self):
        payload = line_payload()
        response = self.client.post("/parameter-search/prepare", json=payload)
        self.assertEqual(response.status_code, 200, response.get_json())
        prepared = response.get_json()
        self.assertEqual([p["name"] for p in prepared["parameters"]], ["slope", "intercept"])
        payload["bounds"] = [[p["lower"], p["upper"]] for p in prepared["parameters"]]
        response = self.client.post("/parameter-search", json=payload)
        self.assertEqual(response.status_code, 202, response.get_json())
        job_id = response.get_json()["job_id"]
        self.addCleanup(manager.cancel, job_id)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            result = self.client.get("/parameter-search/" + job_id).get_json()
            if result["status"] != "running":
                break
            time.sleep(.1)
        self.assertEqual(result["status"], "complete", result)
        self.assertEqual(len(result["result"]["values"]), 2)
        self.assertEqual(self.client.get("/parameter-search/missing").status_code, 404)
        self.assertEqual(self.client.delete("/parameter-search/missing").status_code, 404)

    def test_cancellation_is_available_cross_origin(self):
        response = self.client.options("/parameter-search/missing", headers={
            "Origin": "https://example.org", "Access-Control-Request-Method": "DELETE"})
        self.assertIn("DELETE", response.headers["Access-Control-Allow-Methods"])

    def test_prepare_allows_fixing_parameters_before_strict_search_validation(self):
        payload = dict(x=[0, 1], y=[1, 3], formula="[0]*x+[1]", time_budget=1)
        prepared = self.client.post("/parameter-search/prepare", json=payload)
        self.assertEqual(prepared.status_code, 200, prepared.get_json())
        self.assertTrue(prepared.get_json()["warnings"])
        self.assertEqual(self.client.post("/parameter-search", json=payload).status_code, 400)
        payload["bounds"] = [[-10, 10], [1, 1]]
        started = self.client.post("/parameter-search", json=payload)
        self.assertEqual(started.status_code, 202, started.get_json())
        manager.cancel(started.get_json()["job_id"])

    def test_extreme_numeric_input_and_builtin_offsets_are_rejected(self):
        for change in ({"x": [10 ** 400, 1]}, {"initial_guesses": [10 ** 400, 1]},
                       {"formula": "gaus(10000000)"}, {"formula": "pol2(10000000)"}):
            with self.subTest(change=change):
                payload = line_payload()
                payload.update(change)
                response = self.client.post("/parameter-search/prepare", json=payload)
                self.assertEqual(response.status_code, 400, response.get_json())


if __name__ == "__main__":
    unittest.main()
