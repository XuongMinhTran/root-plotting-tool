"""Search scoring and recovery across histogram and shared vector models."""
from pathlib import Path
import sys
import time
import unittest

import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app import app
from parameter_search import prepare, search
from search_jobs import manager


def histogram(method='poisson'):
    return dict(analysis_type='histogram', histogram=dict(source='counts', method=method,
                edges=[0, 1, 2, 4, 7], counts=[10, 0, 20, 30]), formula='[0]', time_budget=1)


def vector():
    x = np.linspace(-2, 3, 21)
    z = np.sin(x)
    return dict(analysis_type='multivariate', n_inputs=2, n_outputs=2,
                inputs=[x.tolist(), z.tolist()], outputs=[(3*x+2*z+5).tolist(), (3*x-4*z+1).tolist()],
                models=['[0]*x0+[1]*x1+[2]', '[0]*x0+[3]*x1+[4]'],
                initial_guesses=[1, 1, 1, 1, 1], time_budget=1)


class ExpandedSearchTests(unittest.TestCase):
    def test_histogram_likelihood_includes_empty_bins_and_unequal_widths(self):
        p = histogram()
        r = search(p)
        self.assertAlmostEqual(r['values'][0], 60/7, places=4)
        mu = np.array([1, 1, 2, 3]) * r['values'][0]
        counts = np.array([10, 0, 20, 30])
        terms = mu - counts
        positive = counts > 0
        terms[positive] += counts[positive] * np.log(counts[positive] / mu[positive])
        self.assertAlmostEqual(r['score'], 2 * terms.sum(), places=7)
        self.assertEqual(r['n_points'], 4)
        np.testing.assert_allclose(r['curve']['y'], mu)

    def test_histogram_chi_square_omits_empty_bins_and_respects_fit_range(self):
        p = histogram('chi2')
        p['x_range'] = [None, 3]
        r = search(p)
        self.assertAlmostEqual(r['values'][0], 10, places=4)
        self.assertEqual(r['n_points'], 2)
        self.assertLess(r['score'], 1e-8)
        p['x_range'] = [None, .9]
        self.assertEqual(len(prepare(p)['parameters']), 1)
        p['bounds'] = [[10, 10]]
        self.assertEqual(search(p)['values'], [10])

    def test_raw_samples_and_pre_binned_counts_agree(self):
        p = histogram()
        p['histogram']['source'] = 'samples'
        p['histogram']['samples'] = [0]*10 + [3]*20 + [7]*30 + [-1, 8]
        r = search(p)
        self.assertAlmostEqual(r['values'][0], 60/7, places=4)
        self.assertTrue(any('1 below and 1 above' in note for note in r['warnings']))

    def test_gaussian_density_is_integrated_over_wide_bins(self):
        import ROOT
        edges = np.array([-5, -3, -2, -1, -.3, .4, 1.5, 3, 5])
        f = ROOT.TF1('test_hist_search_gaussian', 'gausn', -5, 5)
        f.SetParameters(1500, .3, 1.2)
        counts = [round(f.Integral(float(a), float(b))) for a, b in zip(edges[:-1], edges[1:])]
        p = dict(analysis_type='histogram', histogram=dict(source='counts', edges=edges.tolist(), counts=counts),
                 formula='gausn', initial_guesses=[50, -2, 3], time_budget=2)
        r = search(p)
        np.testing.assert_allclose(r['values'], [1500, .3, 1.2], rtol=.004, atol=.01)
        self.assertLess(r['score'], .2)

    def test_vector_search_recovers_shared_parameters_and_all_outputs(self):
        r = search(vector())
        np.testing.assert_allclose(r['values'], [3, 2, 5, -4, 1], atol=1e-6)
        self.assertLess(r['score'], 1e-10)
        self.assertEqual(len(r['curve']['panels']), 2)
        self.assertEqual(len(prepare(vector())['parameters']), 5)

    def test_vector_effective_variance_and_input_range_match_fit_convention(self):
        p = vector()
        p.update(input_errors=[[.1], [.2]], output_errors=[[.3], [.4]],
                 input_ranges=[[-1, 1]], bounds=[[3,3], [2,2], [5,5], [-4,-4], [1,1]])
        p['outputs'][0] = (np.asarray(p['outputs'][0]) + .5).tolist()
        p['outputs'][1] = (np.asarray(p['outputs'][1]) - .8).tolist()
        r = search(p)
        rows = int(((np.asarray(p['inputs'][0]) >= -1) & (np.asarray(p['inputs'][0]) <= 1)).sum())
        expected = rows * (.5**2 / (.3**2 + (3*.1)**2 + (2*.2)**2)
                           + .8**2 / (.4**2 + (3*.1)**2 + (-4*.2)**2))
        self.assertEqual(r['n_points'], rows)
        self.assertAlmostEqual(r['score'], expected, places=7)

    def test_constant_input_and_constant_component_with_shared_index(self):
        p = dict(analysis_type='multivariate', n_inputs=2, n_outputs=2,
                 inputs=[[1]*6, [0,1,2,3,4,5]], outputs=[[5]*6, [5,7,9,11,13,15]],
                 models=['[1]', '[0]*x1+[1]'], time_budget=1)
        np.testing.assert_allclose(search(p)['values'], [2,5], atol=1e-6)
        p['inputs'][0] = [1e20] * 6
        p['models'][0] = '5'
        np.testing.assert_allclose(search(p)['values'], [2,5], atol=1e-6)

    def test_twenty_inputs_are_evaluated_and_tiny_unweighted_units_refine(self):
        x = np.linspace(.1, 2, 20)
        p = dict(analysis_type='multivariate', n_inputs=20, n_outputs=1,
                 inputs=[(x * (d + 1)).tolist() for d in range(20)],
                 outputs=[(2e-12 * x * 20 + 3e-12).tolist()],
                 models=['[0]*x19+[1]'], time_budget=1)
        r = search(p)
        np.testing.assert_allclose(r['values'], [2e-12, 3e-12], rtol=1e-4, atol=1e-16)
        self.assertLess(r['score'], 1e-30)

    def test_endpoint_rejects_invalid_vector_and_histogram_inputs_before_start(self):
        client = app.test_client()
        invalid = [dict(vector(), models=['gaus', 'pol0']),
                   dict(vector(), models=['system(x0)', '[0]']),
                   dict(vector(), models=['[20]*x0', '[0]']),
                   dict(vector(), models=['[0]*x2', '[0]']),
                   dict(vector(), input_errors=[[-1], []]),
                   dict(vector(), output_errors=[[float('nan')], []]),
                   dict(vector(), models=['[named]*x0', '[0]']),
                   dict(vector(), input_ranges=[[2,1]]),
                   dict(vector(), n_inputs=2.5),
                   dict(histogram(), histogram=dict(source='counts', edges=[0,1,1], counts=[2,3])),
                   dict(histogram(), histogram=dict(source='counts', edges=[0,1,2], counts=[-1,3])),
                   dict(histogram(), histogram=dict(source='counts', method='bad', edges=[0,1,2], counts=[1,3]))]
        for p in invalid:
            with self.subTest(p=p):
                response = client.post('/parameter-search', json=p)
                self.assertEqual(response.status_code, 400, response.get_json())

    def test_both_analysis_types_use_async_search_endpoints(self):
        client = app.test_client()
        for p in (histogram(), vector()):
            with self.subTest(kind=p['analysis_type']):
                response = client.post('/parameter-search/prepare', json=p)
                self.assertEqual(response.status_code, 200, response.get_json())
                self.assertEqual(response.get_json()['analysis_type'], p['analysis_type'])
                response = client.post('/parameter-search', json=p)
                self.assertEqual(response.status_code, 202, response.get_json())
                job = response.get_json()['job_id']
                self.addCleanup(manager.cancel, job)
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    response = client.get('/parameter-search/' + job).get_json()
                    if response['status'] != 'running':
                        break
                    time.sleep(.1)
                self.assertEqual(response['status'], 'complete', response)
                self.assertEqual(response['result']['analysis_type'], p['analysis_type'])


if __name__ == '__main__':
    unittest.main()
