"""HTTP regression checks: docker run --rm --platform linux/amd64 -v "$PWD":/work -w /work/backend rootfit-backend python3 app_test.py"""
import json
import pathlib
import unittest
from unittest.mock import patch

from app import app


class FitResponseTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def post_fit(self, payload):
        response = self.client.post('/fit', json=payload)
        def reject_constant(value):
            raise AssertionError(f'Non-standard JSON constant: {value}')
        return response.status_code, json.loads(response.data, parse_constant=reject_constant)

    def test_nonfinite_result_is_actionable_json_error(self):
        for value in (float('nan'), float('inf'), float('-inf')):
            with self.subTest(value=value), patch('app.fit.run_fit', return_value={'covariance': [[value]]}):
                status, body = self.post_fit({'x': [0, 1], 'y': [1, 2], 'formula': 'pol1'})
                self.assertEqual(status, 400)
                self.assertIn('initial guesses', body['error'])

    def test_decay_starting_values(self):
        example = next((pathlib.Path(__file__).resolve().parent.parent / 'examples').glob('*decay*'))
        data = json.loads(example.read_text())['inputs']['data']
        payload = {key: list(map(float, values.split())) for key, values in data.items()}
        payload.update(formula='[0]*exp(-x/[1])', plot={'residuals': 'none'})
        payload['initial_guesses'] = [1, 1]
        status, body = self.post_fit(payload)
        self.assertEqual(status, 400)
        self.assertIn('stable curve', body['error'])
        payload['initial_guesses'] = [1000, 2]
        status, body = self.post_fit(payload)
        self.assertEqual(status, 200)
        self.assertTrue(body['converged'])
        self.assertEqual(body['canvas_json']['_typename'], 'TCanvas')

    def test_shared_errors_match_repeated_columns(self):
        base = {'x': [0, 1, 2, 3], 'y': [1, 3.1, 4.9, 7], 'formula': 'pol1'}
        for ex, ey in (([0.1], []), ([], [0.2]), ([0.1], [0.2]), ([0], [0.2])):
            with self.subTest(ex=ex, ey=ey):
                status, shared = self.post_fit(dict(base, ex=ex, ey=ey))
                status2, repeated = self.post_fit(dict(base, ex=ex * 4, ey=ey * 4))
                self.assertEqual((status, status2), (200, 200))
                for a, b in zip(shared['params'], repeated['params']):
                    self.assertAlmostEqual(a['value'], b['value'])
                    self.assertAlmostEqual(a['error'], b['error'])

    def test_diagnostics_are_opt_in(self):
        base = {'x': [0, 1, 2, 3], 'y': [1, 3.1, 4.9, 7], 'ey': [0.2], 'formula': 'pol1'}
        for kind in (None, 'none', 'residual', 'pull'):
            payload = dict(base)
            if kind is not None:
                payload['plot'] = {'residuals': kind}
            status, body = self.post_fit(payload)
            self.assertEqual(status, 200)
            self.assertEqual(body['residuals']['kind'], kind or 'none')
            primitives = body['canvas_json']['fPrimitives']['arr']
            pads = [p for p in primitives if p.get('_typename') == 'TPad']
            self.assertEqual(len(pads), 2 if kind in ('residual', 'pull') else 0)
            self.assertEqual('values' in body['residuals'], kind in ('residual', 'pull'))

    def test_invalid_error_columns_explain_choices(self):
        base = {'x': [0, 1, 2], 'y': [1, 3, 5], 'formula': 'pol1'}
        for axis in ('ex', 'ey'):
            status, body = self.post_fit(dict(base, **{axis: [0.1, 0.2]}))
            self.assertEqual(status, 400)
            self.assertIn('one value for the whole axis', body['error'])
            status, body = self.post_fit(dict(base, **{axis: [-1]}))
            self.assertEqual(status, 400)
            self.assertIn('zero or a positive number', body['error'])

    def test_nonfinite_guesses_are_rejected_before_root(self):
        for guess in ('NaN', 'Infinity'):
            status, body = self.post_fit({'x': [0, 1, 2], 'y': [1, 3, 5], 'formula': 'pol1', 'initial_guesses': [guess]})
            self.assertEqual(status, 400)
            self.assertIn('finite number', body['error'])

    def test_multiple_diagnostics_and_custom_settings(self):
        kinds = ['residual', 'pull', 'ratio', 'percent', 'histogram']
        config = [dict(kind=k, title='Custom ' + k, x_title='Custom X', y_title='Custom Y', height=280,
                       y_min=-10, y_max=20, grid=False, reference=False, errors=False, bins=7) for k in kinds]
        status, body = self.post_fit({'x': [0, 1, 2, 3], 'y': [1, 3.1, 4.9, 7], 'ey': [0.2],
                                      'formula': 'pol1', 'plot': {'diagnostics': config}})
        self.assertEqual(status, 200)
        panels = {p['kind']: p for p in body['diagnostics']}
        self.assertEqual(list(panels), kinds)
        self.assertEqual(body['plot_height'], 500 + 5 * 280)
        for kind, panel in panels.items():
            self.assertEqual(panel['title'], 'Custom ' + kind)
            self.assertEqual(panel['y_min'], -10)
            self.assertFalse(panel['grid'])
        for i in range(4):
            residual = panels['residual']['values'][i]
            self.assertAlmostEqual(panels['pull']['values'][i], residual / 0.2)
            self.assertAlmostEqual(panels['percent']['values'][i], 100 * (panels['ratio']['values'][i] - 1))
        self.assertEqual(sum(panels['histogram']['counts']), 4)
        self.assertEqual(len(panels['histogram']['counts']), 7)
        pads = [p for p in body['canvas_json']['fPrimitives']['arr'] if p.get('_typename') == 'TPad']
        self.assertEqual(len(pads), 6)
        serialized = json.dumps(body['canvas_json'])
        for kind in kinds:
            self.assertIn('Custom ' + kind, serialized)
        self.assertIn('Custom X', serialized)
        self.assertIn('Custom Y', serialized)

    def test_unavailable_diagnostics_do_not_discard_fit(self):
        # A fixed zero model gives an exact, rather than nearly zero, denominator.
        status, body = self.post_fit({'x': [0, 1, 2, 3], 'y': [0, 0, 0, 0], 'formula': 'pol0',
                'plot': {'diagnostics': [{'kind': k} for k in ['residual', 'pull', 'ratio', 'percent', 'histogram']]}})
        self.assertEqual(status, 200)
        self.assertEqual([p['kind'] for p in body['diagnostics']], ['residual', 'histogram'])
        self.assertTrue(body['plot_notes'])
        self.assertEqual(sum(body['diagnostics'][-1]['counts']), 4)

    def test_diagnostic_ranges_and_legacy_priority(self):
        base = {'x': [0, 1, 2, 3], 'y': [1, 3.1, 4.9, 7], 'ey': [0.2], 'formula': 'pol1', 'x_range': [1, 3]}
        for scope, count in [('fit', 3), ('all', 4)]:
            status, body = self.post_fit(dict(base, plot={'diagnostics': [{'kind': 'residual', 'scope': scope}]}))
            self.assertEqual(status, 200)
            self.assertEqual(body['diagnostics'][0]['n_points'], count)
        status, body = self.post_fit(dict(base, plot={'residuals': 'pull', 'diagnostics': []}))
        self.assertEqual(status, 200)
        self.assertEqual(body['diagnostics'], [])
        self.assertIsNone(body['plot_height'])
        for config in [{'kind': 'ratio', 'y_min': 2, 'y_max': 1}, {'kind': 'histogram', 'bins': 0},
                       {'kind': 'pull', 'height': 'NaN'}]:
            status, body = self.post_fit(dict(base, plot={'diagnostics': [config]}))
            self.assertEqual(status, 400)
            self.assertIn('error', body)


if __name__ == '__main__':
    unittest.main()
