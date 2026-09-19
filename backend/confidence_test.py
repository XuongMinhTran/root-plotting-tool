import unittest
import numpy as np
import fit

class ConfidenceTests(unittest.TestCase):
    def test_linear_covariance_band_and_excluded_markers(self):
        r=fit.run_fit([1,2,3,4,5],[2.1,4.,6.2,7.9,10.1],ey=[.2],formula='[0]*x+[1]',plot={'confidence_level':.95,'excluded_points':[{'x':3,'y':9}]})
        b=r['confidence_band'];self.assertEqual(len(b['x']),201)
        for i in [0,100,200]:
            x=b['x'][i];c=np.asarray(r['covariance']);expected=1.95996398454*np.sqrt(np.array([x,1])@c@np.array([x,1]))
            self.assertAlmostEqual(b['errors'][i],expected,places=5)
        self.assertIn('excluded_points',str(r['canvas_json']))
        self.assertIn('confidence_band',str(r['canvas_json']))
    def test_optional_and_invalid_level(self):
        args=([1,2,3,4],[2,4.1,6,8.1])
        self.assertIsNone(fit.run_fit(*args,ey=[.1])['confidence_band'])
        with self.assertRaises(ValueError):fit.run_fit(*args,ey=[.1],plot={'confidence_level':2})
if __name__=='__main__':unittest.main()
