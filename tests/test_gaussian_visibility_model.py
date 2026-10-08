"""Regression checks for the nine-parameter double-slit library model.

Run with the backend's ROOT, NumPy and Flask dependencies installed:
    python3 -m unittest discover -s tests -v
"""

import json
import math
from pathlib import Path
import re
import sys
import unittest

import ROOT

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from app import app
from formula_check import check_formula


def library_model():
    source = (REPO / "frontend/model-library.js").read_text()
    data = json.loads(re.search(r"const DATA = (.*?);\s*const norm", source, re.S).group(1))
    return next(model for model in data["models"]
                if model["name"] == "Double-slit (Gaussian fringe visibility)")


def reference(x, parameters):
    """The supplied physical equation, with its continuous sinc limit."""
    n0, background, ka, kd, envelope_center, fringe_origin, visibility, center, width = parameters
    z = ka * (x - envelope_center)
    envelope = 1.0 if z == 0 else (math.sin(z) / z) ** 2
    contrast = visibility * math.exp(-((x - center) / width) ** 2)
    return background + n0 / 2 * envelope * (1 + contrast * math.cos(2 * kd * (x - fringe_origin)))


class GaussianVisibilityModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = library_model()
        cls.guesses = [float(value) for value in cls.model["guesses"].split(",")]
        # Independent synthetic experiment; library defaults are only placeholders.
        cls.parameters = [400, 7, 1.3, 4.1, 0.2, 0.7, 0.8, 1.3, 2.4]
        cls.function = ROOT.TF1("gaussian_visibility_test", cls.model["formula"], -2, 2)

    def test_formula_is_accepted_with_nine_parameters(self):
        ok, message = check_formula(self.model["formula"])
        self.assertTrue(ok, message)
        self.assertTrue(self.function.IsValid())
        self.assertEqual(self.function.GetNpar(), 9)
        self.assertEqual(len(self.model["params"].split(",")), 9)
        self.assertEqual(len(self.guesses), 9)

    def test_equation_and_continuous_envelope_center(self):
        for parameters in (self.guesses, self.parameters):
            self.function.SetParameters(*parameters)
            center = parameters[4]
            for x in (-2, -1, center - 1e-10, center, center + 1e-10, 1, 2):
                with self.subTest(parameters=parameters, x=x):
                    actual = self.function.Eval(x)
                    self.assertTrue(math.isfinite(actual))
                    self.assertAlmostEqual(actual, reference(x, parameters), delta=1e-8)

    def test_zero_envelope_scale_and_zero_visibility_limits(self):
        parameters = self.parameters.copy()
        parameters[2] = 0
        parameters[6] = 0
        self.function.SetParameters(*parameters)
        for x in (-2, parameters[4], 2):
            self.assertAlmostEqual(self.function.Eval(x), parameters[1] + parameters[0] / 2)

    def test_fit_endpoint_recovers_synthetic_curve_from_perturbed_guesses(self):
        x = [-2 + 0.05 * i for i in range(81)]
        y = [reference(value, self.parameters) for value in x]
        guesses = self.parameters.copy()
        for index, factor in ((0, 0.95), (1, 1.1), (2, 1.02), (3, 0.99), (6, 0.9), (8, 1.05)):
            guesses[index] *= factor
        guesses[4] += 0.02
        guesses[5] += 0.02
        guesses[7] -= 0.05
        with app.test_client() as client:
            response = client.post("/fit", json={
                "x": x, "y": y, "ey": [math.sqrt(value) for value in y],
                "formula": self.model["formula"],
                "param_names": self.model["params"], "initial_guesses": guesses,
                "x_range": [-2, 2],
            })
        result = response.get_json()
        self.assertEqual(response.status_code, 200, result.get("error"))
        self.assertTrue(result["converged"], result["status_message"])
        self.assertEqual(result["ndf"], 72)
        self.assertEqual([p["name"] for p in result["params"]],
                         [name.strip() for name in self.model["params"].split(",")])
        self.assertLess(result["chi2"], 0.001)
        self.assertTrue(result["canvas_json"])


if __name__ == "__main__":
    unittest.main()
