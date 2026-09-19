"""Histogram regressions with independent count-likelihood references."""
import math
import json
import unittest
from app import app


class HistogramTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def submit(self, histogram, **kwargs):
        response = self.client.post('/histogram', json=dict(histogram=histogram, formula='[0]', **kwargs))
        self.assertEqual(response.status_code, 200, response.json)
        return response.json

    def test_variable_width_poisson_rate_and_uncertainty(self):
        # Independent MLE for a constant rate: sum(counts) / total exposure.
        r = self.submit(dict(source='counts', edges=[0, 1, 3, 6], counts=[10, 20, 30]))
        self.assertTrue(r['converged'])
        self.assertAlmostEqual(r['params'][0]['value'], 10, delta=.002)
        self.assertAlmostEqual(r['params'][0]['error'], math.sqrt(60)/6, delta=.02)
        self.assertIsNone(r['chi2'])
        self.assertIsNone(r['prob'])
        self.assertLess(r['statistic'], .001)
        self.assertEqual(r['histogram']['counts'], [10,20,30])

    def test_empty_bins_enter_likelihood(self):
        r = self.submit(dict(source='counts', edges=[0,1,2,3,4], counts=[0,4,0,4]))
        self.assertAlmostEqual(r['params'][0]['value'], 2, delta=.002)
        self.assertEqual(r['n_points'], 4)
        self.assertAlmostEqual(r['statistic'], 16*math.log(2), delta=.002)

    def test_curved_model_uses_integrals_not_centers(self):
        # integral of 3*x*x over [a,b] is b**3-a**3.
        response = self.client.post('/histogram', json={
            'histogram':dict(source='counts', edges=[0,1,2,4], counts=[1,7,56]),
            'formula':'[0]*x*x', 'initial_guesses':[2],
            'plot':{'diagnostics':[{'kind':'residual'}]}})
        self.assertEqual(response.status_code,200,response.json)
        r = response.json
        self.assertAlmostEqual(r['params'][0]['value'],3,delta=.002)
        self.assertLess(max(abs(v) for v in r['diagnostics'][0]['values']),.02)
        types = [obj['_typename'] for obj in r['canvas_json']['fPrimitives']['arr']]
        self.assertIn('TPad',types)

    def test_gaussian_starts_without_manual_guesses(self):
        response = self.client.post('/histogram', json={
            'histogram':dict(source='counts', edges=list(range(11)), counts=[1,3,12,40,80,80,40,12,3,1]),
            'formula':'gaus'})
        self.assertEqual(response.status_code,200,response.json)
        self.assertTrue(response.json['converged'])
        self.assertAlmostEqual(response.json['params'][1]['value'],5,delta=.02)
        types = [obj['_typename'] for obj in response.json['canvas_json']['fPrimitives']['arr']]
        self.assertIn('TH1D',types)
        self.assertIn('TF1',types)

    def test_histogram_presets_start_and_fit_without_manual_guesses(self):
        import ROOT
        models = [
            ('gausn', [5000, 5, 1], 0, 10),
            ('gaus', [2000, 5, 1], 0, 10),
            ('gaus(0)+pol0(3)', [2000, 5, 1, 100], 0, 10),
            ('landau', [15000, 3, .7], 0, 15),
            ('expo', [8, -.4], 0, 10),
            ('pol0', [100], 0, 10),
        ]
        for formula, parameters, lo, hi in models:
            with self.subTest(formula=formula):
                truth = ROOT.TF1('preset_truth', formula, lo, hi)
                for i, value in enumerate(parameters):
                    truth.SetParameter(i, value)
                edges = [lo + (hi-lo)*i/40 for i in range(41)]
                counts = [round(truth.Integral(a,b)) for a,b in zip(edges[:-1],edges[1:])]
                response = self.client.post('/histogram', json={
                    'histogram':dict(source='counts', edges=edges, counts=counts),
                    'formula':formula})
                self.assertEqual(response.status_code, 200, response.json)
                self.assertTrue(response.json['converged'], response.json['status_message'])
                for fitted, expected in zip(response.json['params'], parameters):
                    self.assertAlmostEqual(fitted['value'], expected, delta=max(abs(expected)*.04,.03))

    def test_fit_parameters_are_visible_on_canvas_with_panels(self):
        response = self.client.post('/histogram', json={
            'histogram':dict(source='counts', edges=list(range(11)), counts=[1,3,12,40,80,80,40,12,3,1]),
            'formula':'gausn', 'param_names':['norm','mean','sigma'],
            'plot':{'diagnostics':[{'kind':'residual'}]}})
        self.assertEqual(response.status_code,200,response.json)
        self.assertAlmostEqual(response.json['params'][0]['value'],272,delta=.2)
        canvas = json.dumps(response.json['canvas_json'])
        for text in ['histogram_summary', 'norm = ', 'mean = ', '#sigma = ', '#pm', 'Deviance / NDF']:
            self.assertIn(text,canvas)
        self.assertNotIn('p-value =',canvas)

    def test_plot_only_has_distribution_statistics(self):
        r=self.submit(dict(source='samples', samples=[0,1,2,3,4], bins=2), fit_model=False)
        canvas=json.dumps(r['canvas_json'])
        for text in ['Counts = 5','mean = 2','std. dev. = 1.414']:
            self.assertIn(text,canvas)

    def test_raw_counts_edges_and_outliers(self):
        r = self.submit(dict(source='samples', samples=[-1,0,.5,1,2,3,4], edges=[0,1,3]), fit_model=False)
        self.assertEqual(r['histogram']['counts'], [2,3])
        self.assertEqual(r['histogram']['underflow'], 1)
        self.assertEqual(r['histogram']['overflow'], 1)
        self.assertFalse(r['fit_performed'])
        self.assertEqual(r['params'], [])
        self.assertEqual(r['canvas_json']['_typename'], 'TCanvas')

    def test_blank_bins_use_range_width(self):
        from histogram_fit import prepare
        cases = [
            ({}, [2, 5], 3),
            ({'bins':''}, [2, 5], 3),
            ({'bins':None, 'range':[-2, 8]}, [0, 4], 10),
            ({}, [.1, 2.5], 3),
            ({}, [.1, .3], 1),
            ({}, [5, 5], 1),
            ({'bins':7}, [2, 5], 7),
            ({'edges':[0, 2, 6]}, [2, 5], 2),
        ]
        for options, samples, expected in cases:
            with self.subTest(options=options, samples=samples):
                edges, counts, under, over = prepare(dict(source='samples', samples=samples, **options))
                self.assertEqual(len(counts), expected)
                self.assertEqual(sum(counts), len(samples))
        with self.assertRaisesRegex(ValueError, 'Enter a bin count'):
            prepare(dict(samples=[0, 2001]))
        self.assertEqual(len(prepare(dict(samples=[0, 2001], bins=10))[1]), 10)

    def test_automatic_range_includes_maximum(self):
        r = self.submit(dict(source='samples', samples=[0,1,2,3,4], bins=2), fit_model=False)
        self.assertEqual(r['histogram']['counts'], [2,3])
        self.assertEqual(r['histogram']['overflow'], 0)

    def test_chi2_density_and_empty_bins(self):
        r = self.submit(dict(source='counts', edges=[0,1,3,6,7], counts=[10,20,30,0], method='chi2'))
        self.assertAlmostEqual(r['params'][0]['value'], 10, delta=.002)
        self.assertEqual(r['n_points'], 3)
        self.assertLess(r['chi2'], .001)

    def test_diagnostics_use_integrated_counts(self):
        r = self.submit(dict(source='counts', edges=[0,1,3,6], counts=[10,20,30]),
                        plot={'diagnostics':[{'kind':k} for k in ['residual','pull','ratio','percent','histogram']]})
        self.assertEqual(len(r['diagnostics']), 5)
        self.assertLess(max(abs(v) for v in r['diagnostics'][0]['values']), .01)
        self.assertEqual(r['diagnostics'][0]['x_errors'], [0,0,0])

    def test_validation(self):
        for h in [
            dict(source='counts', edges=[0,1,1,3], counts=[1,2,3]),
            dict(source='counts', edges=[0,1,2], counts=[1]),
            dict(source='counts', edges=[0,1,2], counts=[1,-2]),
            dict(source='counts', edges=[0,1,2], counts=[1,.5]),
            dict(source='counts', edges=[0,1,2], counts=[0,0]),
            dict(source='samples', samples=[1,2], bins=2.5),
            dict(source='samples', samples=[1,2], range=[2,1]),
            dict(source='samples', samples=[float('nan')]),
            dict(source='samples', samples=[[1],[2]]),
        ]:
            response = self.client.post('/histogram',json={'histogram':h,'fit_model':False})
            self.assertEqual(response.status_code,400,response.json)
            self.assertIn('error',response.json)

    def test_rejects_unsafe_formula_and_bad_fit_range(self):
        h = dict(source='counts', edges=[0,1,2,3], counts=[2,3,4])
        for kwargs in [dict(formula='gSystem->Exec("ls")'), dict(formula='[0]', x_range=[2,1]), dict(formula='[0]',x_range=[0,.1])]:
            response=self.client.post('/histogram',json={'histogram':h,**kwargs})
            self.assertEqual(response.status_code,400,response.json)


if __name__ == '__main__':
    unittest.main()
