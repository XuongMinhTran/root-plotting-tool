/*
 * model-library.js — a guided library of common undergraduate-physics fit
 * models. The "Model library…" button opens a browsable, categorised dialog;
 * choosing a model fills the fit function, parameter names and starting guesses
 * (via applyFunctionExample). Each model carries per-parameter guidance on how
 * to read good starting guesses off the data; that guidance is surfaced both
 * here and in the "Help with parameters" popover (see guideFor). Loaded on the
 * Classic and Standard pages only. Every formula is validated (check_formula)
 * and every non-linear one is confirmed to converge (scipy) in scratch/models.py.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const DATA = {"categories": ["Mechanics & motion", "Waves & optics", "Thermal & statistical", "Electricity & magnetism", "Modern physics", "General shapes"], "models": [{"cat": "Mechanics & motion", "name": "Straight line", "formula": "[0]*x+[1]", "params": "slope, intercept", "guesses": "1, 0", "desc": "Any linear relationship: Ohm's law (V–I), Hooke's law (F–x), a calibration line, or constant-velocity motion.", "x": "x", "y": "y", "guide": ["slope — rise over run between two well-separated points: (y₂ − y₁)/(x₂ − x₁)", "intercept — the y-value where the line reaches x = 0 (extend it back, or y₁ − slope·x₁)"]}, {"cat": "Mechanics & motion", "name": "Proportional (through origin)", "formula": "[0]*x", "params": "slope", "guesses": "1", "desc": "A straight line forced through the origin — use when theory requires y = 0 at x = 0.", "x": "x", "y": "y", "guide": ["slope — the average of y/x over your points (it should be roughly constant)"]}, {"cat": "Mechanics & motion", "name": "Free fall / projectile", "formula": "pol2", "params": "y0, v0, half_g", "guesses": "", "desc": "Constant acceleration: y = y0 + v0 t + ½ a t². Position vs time; the quadratic term gives ½·acceleration.", "x": "time (s)", "y": "position (m)", "guide": ["Leave the guesses blank — ROOT estimates the parabola automatically.", "If you set them: y0 = position at t = 0 · v0 = initial slope · half_g = ½ × acceleration (≈ −4.9 m/s² for gravity downward)"]}, {"cat": "Mechanics & motion", "name": "Pendulum period vs length", "formula": "[0]*sqrt(x)", "params": "k", "guesses": "2", "desc": "Simple pendulum T = 2π√(L/g) = k√L. Fit period vs length; g = (2π/k)². (Or fit T² vs L as a straight line.)", "x": "length L (m)", "y": "period T (s)", "guide": ["k — take any point and compute T ÷ √L; expect about 2.0 s/√m, since k = 2π/√g"]}, {"cat": "Mechanics & motion", "name": "Simple harmonic motion", "formula": "[0]*sin([1]*x+[2])+[3]", "params": "amplitude, omega, phase, offset", "guesses": "1, 1, 0, 0", "desc": "Undamped oscillation x(t) = A sin(ωt + φ) + c. Set omega ≈ 2π/period from the data before fitting.", "x": "time (s)", "y": "displacement", "guide": ["amplitude — half the peak-to-trough height of the data", "omega — 2π ÷ the period (the x-distance between repeats)", "phase — start at 0, then nudge to line up the first upward zero-crossing", "offset — the midline: the average of the maximum and minimum"]}, {"cat": "Mechanics & motion", "name": "Damped oscillation", "formula": "[0]*exp(-x/[1])*cos([2]*x+[3])+[4]", "params": "amplitude, tau, omega, phase, offset", "guesses": "1, 5, 6.283, 0, 0", "desc": "Decaying oscillation A e^(−t/τ) cos(ωt + φ) + c — a mass on a spring with friction, or a ringing circuit. Estimate τ and ω from the envelope and spacing of the peaks.", "x": "time (s)", "y": "displacement", "guide": ["amplitude — the height of the first peak above the offset", "tau — the x where the swing has shrunk to about 1/e (37%) of that first peak", "omega — 2π ÷ the period (spacing between successive peaks)", "phase — 0 if it starts near a maximum, about π/2 if it starts near zero", "offset — the value it eventually settles to"]}, {"cat": "Mechanics & motion", "name": "Terminal velocity (approach)", "formula": "[0]*(1-exp(-x/[1]))", "params": "v_terminal, tau", "guesses": "1, 1", "desc": "Speed of a falling body with drag: v(t) = v_term (1 − e^(−t/τ)). Rises and levels off at the terminal value.", "x": "time (s)", "y": "velocity (m/s)", "guide": ["v_terminal — the plateau the data level off to", "tau — the x where the rise has reached about 63% of that plateau"]}, {"cat": "Waves & optics", "name": "Single-slit diffraction (Fraunhofer)", "formula": "[0]*pow(sin([1]*(x-[2])+1e-6)/([1]*(x-[2])+1e-6),2)+[3]", "params": "I0, beta_scale, center, background", "guesses": "1, 1, 0, 0", "desc": "Fraunhofer single-slit intensity I = I0 · sinc²(β), β = π a (x−x0)/(λ L). The central peak with weaker side lobes. beta_scale ≈ π a/(λL).", "x": "screen position", "y": "intensity", "guide": ["I0 — height of the central peak above the background", "center — the x-position of the central maximum", "background — the floor away from the pattern", "beta_scale — π ÷ (distance from the center to the first dark minimum), since the first zero is at β = π"]}, {"cat": "Waves & optics", "name": "Double-slit (with single-slit envelope)", "formula": "[0]*pow(cos([1]*(x-[2])),2)*pow(sin([3]*(x-[2])+1e-6)/([3]*(x-[2])+1e-6),2)+[4]", "params": "I0, delta_scale, center, beta_scale, background", "guesses": "1, 5, 0, 1, 0", "desc": "Two-slit fringes cos²(δ) modulated by the single-slit envelope sinc²(β). delta_scale sets the fringe spacing (slit separation), beta_scale the envelope (slit width).", "x": "screen position", "y": "intensity", "guide": ["I0 — height of the tallest fringe above the background", "center — x-position of the central (brightest) fringe", "background — the floor", "delta_scale — π ÷ (spacing between adjacent bright fringes)", "beta_scale — π ÷ (distance from the center to where the fringes fade out, the envelope's first minimum)"]}, {"cat": "Waves & optics", "name": "Malus's law (polarization)", "formula": "[0]*pow(cos(x-[1]),2)+[2]", "params": "I0, angle0, background", "guesses": "1, 0, 0", "desc": "Transmission through a polarizer: I = I0 cos²(θ − θ0) + background. Enter the angle θ in radians.", "x": "angle (rad)", "y": "intensity", "guide": ["I0 — the maximum intensity minus the background", "angle0 — the angle (in radians) where the intensity is greatest", "background — the minimum (leakage) intensity"]}, {"cat": "Waves & optics", "name": "Lorentzian / resonance peak", "formula": "[0]/(1+pow((x-[1])/[2],2))+[3]", "params": "amplitude, center, gamma, background", "guesses": "1, 0, 1, 0", "desc": "A resonance line shape (Breit–Wigner): driven oscillator amplitude, an RLC resonance curve, or a spectral line. gamma is the half-width at half-maximum.", "x": "x", "y": "amplitude", "guide": ["amplitude — peak height above the background", "center — the x at the peak", "gamma — the half-width at half-maximum: half the peak's full width measured at half its height", "background — the floor"]}, {"cat": "Waves & optics", "name": "Gaussian peak", "formula": "gaus", "params": "height, mean, sigma", "guesses": "", "desc": "A bell-shaped peak: a spectral line, a beam profile, or a distribution of measurements. ROOT estimates the starting values for a bare gaus.", "x": "x", "y": "y", "guide": ["Leave the guesses blank — ROOT reads the height, mean and sigma from the data.", "If you set them: height = peak value · mean = peak position · sigma = (full width at half maximum) ÷ 2.355"]}, {"cat": "Waves & optics", "name": "Gaussian peak + linear background", "formula": "gaus(0)+pol1(3)", "params": "height, mean, sigma, bg_offset, bg_slope", "guesses": "", "desc": "A Gaussian peak sitting on a sloping background. Because it is a sum of named functions, give rough starting values (peak height, centre, width, background).", "x": "x", "y": "y", "guide": ["height — peak height above the sloping background line", "mean — the peak position", "sigma — (full width at half maximum) ÷ 2.355", "bg_offset — the background level extrapolated to x = 0", "bg_slope — the slope of the baseline on either side of the peak"]}, {"cat": "Thermal & statistical", "name": "Newton's law of cooling", "formula": "[0]+[1]*exp(-x/[2])", "params": "T_env, deltaT, tau", "guesses": "20, 50, 100", "desc": "An object relaxing to room temperature: T(t) = T_env + ΔT e^(−t/τ). T_env is the surrounding temperature, τ the cooling time.", "x": "time (s)", "y": "temperature", "guide": ["T_env — the temperature it levels off to (the surroundings)", "deltaT — the starting temperature minus T_env", "tau — the time to cover about 63% of the way from start to T_env"]}, {"cat": "Thermal & statistical", "name": "Radioactive / exponential decay", "formula": "[0]*exp(-x/[1])", "params": "N0, tau", "guesses": "1, 1", "desc": "Exponential decay N = N0 e^(−t/τ); half-life = τ ln 2. Radioactive counts, capacitor discharge, or any first-order decay. (The tool estimates N0 and τ from the data.)", "x": "time", "y": "counts", "guide": ["N0 — the value at x = 0", "tau — the time to fall to about 37% (1/e) of N0; or half-life ÷ 0.693"]}, {"cat": "Thermal & statistical", "name": "Exponential decay + background", "formula": "[0]*exp(-x/[1])+[2]", "params": "N0, tau, background", "guesses": "1, 1, 0", "desc": "Decay sitting on a constant background (e.g. counts above a steady rate). Compare with the plain decay to see whether the background term is needed.", "x": "time", "y": "counts", "guide": ["background — the steady level reached at late times", "N0 — the value at x = 0 minus the background", "tau — the time for the excess above background to fall to about 37%"]}, {"cat": "Thermal & statistical", "name": "Stefan–Boltzmann (power law)", "formula": "[0]*pow(x,[1])", "params": "a, n", "guesses": "1, 4", "desc": "A power law y = a xⁿ. Radiated power vs temperature (n ≈ 4), or any scaling law. On log–log axes this is a straight line of slope n.", "x": "x", "y": "y", "guide": ["n — the exponent; on log–log axes it is the slope (≈ 4 for thermal radiation)", "a — pick one point and compute y ÷ xⁿ using your n estimate"]}, {"cat": "Thermal & statistical", "name": "Arrhenius rate", "formula": "[0]*exp(-[1]/x)", "params": "A, Ea_over_k", "guesses": "1, 1000", "desc": "A thermally activated rate k = A e^(−Ea/kT). The activation energy sits in the exponent; a plot of ln k vs 1/T is a straight line.", "x": "temperature (K)", "y": "rate", "guide": ["Ea_over_k — from two points: (ln y₂ − ln y₁) ÷ (1/x₁ − 1/x₂)", "A — y ÷ exp(−Ea_over_k / x) at any point (the high-temperature limit)"]}, {"cat": "Electricity & magnetism", "name": "RC charging", "formula": "[0]*(1-exp(-x/[1]))", "params": "V_final, RC", "guesses": "5, 1", "desc": "A capacitor charging through a resistor: V(t) = V_final (1 − e^(−t/RC)). The time constant RC is where it reaches 63% of the final voltage.", "x": "time (s)", "y": "voltage (V)", "guide": ["V_final — the plateau voltage the curve rises to", "RC — the time to reach 63% of V_final"]}, {"cat": "Electricity & magnetism", "name": "RC discharging", "formula": "[0]*exp(-x/[1])", "params": "V0, RC", "guesses": "5, 1", "desc": "A capacitor discharging through a resistor: V(t) = V0 e^(−t/RC). Same time constant as charging.", "x": "time (s)", "y": "voltage (V)", "guide": ["V0 — the voltage at t = 0", "RC — the time to fall to 37% of V0"]}, {"cat": "Electricity & magnetism", "name": "Diode I–V (Shockley)", "formula": "[0]*(exp(x/[1])-1)", "params": "I_sat, nVt", "guesses": "0.000001, 0.05", "desc": "Diode current vs voltage: I = I_sat (e^(V/nV_T) − 1). nV_T ≈ 0.026 V × ideality factor at room temperature.", "x": "voltage (V)", "y": "current (A)", "guide": ["nVt — about 0.026 V × ideality factor (1–2), so roughly 0.026–0.052 V at room temperature", "I_sat — very small; start around 1e-9 to 1e-6 A and adjust until the curve reaches your current scale"]}, {"cat": "Modern physics", "name": "Photoelectric effect", "formula": "[0]*x+[1]", "params": "h_over_e, minus_phi_over_e", "guesses": "0.000000000000004, -2", "desc": "Stopping voltage vs light frequency: V_s = (h/e) f − φ/e. A straight line; the slope is Planck's constant over the electron charge, the intercept gives the work function.", "x": "frequency (Hz)", "y": "stopping voltage (V)", "guide": ["h_over_e — the slope of stopping voltage vs frequency (theory ≈ 4.14e-15 V·s)", "minus_phi_over_e — the (negative) intercept, ≈ −(work function expressed in volts)"]}, {"cat": "Modern physics", "name": "Rydberg / hydrogen lines", "formula": "[0]*x", "params": "Rydberg", "guesses": "10973731", "desc": "Hydrogen spectral lines: 1/λ = R (1/n₁² − 1/n₂²). Plot 1/λ against (1/n₁² − 1/n₂²); the slope is the Rydberg constant.", "x": "1/n1^2 - 1/n2^2", "y": "1/wavelength (1/m)", "guide": ["Rydberg — the slope of 1/λ vs (1/n₁² − 1/n₂²); theory ≈ 1.097e7 per metre"]}, {"cat": "Modern physics", "name": "Compton scattering", "formula": "[0]*x+[1]", "params": "compton_wavelength, lambda0", "guesses": "0.0000000000024, 0", "desc": "Shifted wavelength vs scattering angle: λ' = λ0 + λ_C (1 − cos θ). Plot λ' against (1 − cos θ); the slope is the Compton wavelength.", "x": "1 - cos(theta)", "y": "wavelength (m)", "guide": ["compton_wavelength — the slope of λ' vs (1 − cos θ); theory ≈ 2.43e-12 m", "lambda0 — the intercept: the unshifted wavelength (at θ = 0)"]}, {"cat": "Modern physics", "name": "Beer–Lambert absorption", "formula": "[0]*exp(-[1]*x)", "params": "I0, mu", "guesses": "1, 1", "desc": "Attenuation through a medium: I = I0 e^(−μ x). μ is the absorption coefficient; x is thickness (or concentration × path length).", "x": "thickness", "y": "intensity", "guide": ["I0 — the intensity at x = 0 (no absorber)", "mu — 1 ÷ (thickness that drops the intensity to about 37%); or ln(I0/I) ÷ x at any point"]}, {"cat": "General shapes", "name": "Constant", "formula": "pol0", "params": "c", "guesses": "", "desc": "A flat line y = c. Useful as a background, or to test whether data are consistent with no trend.", "x": "x", "y": "y", "guide": ["c — the average of your y values"]}, {"cat": "General shapes", "name": "Quadratic", "formula": "pol2", "params": "a, b, c", "guesses": "", "desc": "A parabola a + b x + c x². ROOT estimates the starting values.", "x": "x", "y": "y", "guide": ["Leave the guesses blank — ROOT estimates the coefficients."]}, {"cat": "General shapes", "name": "Cubic", "formula": "pol3", "params": "a, b, c, d", "guesses": "", "desc": "A cubic polynomial. Handy for a smooth empirical trend when there is no physical model.", "x": "x", "y": "y", "guide": ["Leave the guesses blank — ROOT estimates the coefficients."]}, {"cat": "General shapes", "name": "Logistic / sigmoid", "formula": "[0]/(1+exp(-[1]*(x-[2])))+[3]", "params": "L, k, x0, offset", "guesses": "1, 1, 0, 0", "desc": "An S-shaped curve rising from one level to another: threshold behaviour, saturation, a switching curve. k sets the steepness, x0 the midpoint.", "x": "x", "y": "y", "guide": ["offset — the lower plateau (the value at small x)", "L — the total rise: upper plateau minus lower plateau", "x0 — the x at the midpoint, halfway up the rise", "k — the steepness ≈ 4 ÷ (x-width over which most of the rise happens); larger k = sharper step"]}]};
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
  let dlg = null, activeCat = 'All', last = null;

  function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'tframe model-library-dialog';
    dlg.setAttribute('aria-labelledby', 'model-library-title');
    dlg.innerHTML =
      '<div class="titlebar" id="model-library-title">Model library</div>' +
      '<div class="ml-body">' +
      '<p class="ml-intro">Pick a model for your experiment. Choosing one fills in the fit function, parameter names and starting guesses. Open <em>How to estimate these guesses</em> to estimate starting values from your data, then press Fit.</p>' +
      '<input class="ml-search" type="search" placeholder="Search — e.g. decay, diffraction, cooling…" aria-label="Search models">' +
      '<div class="ml-cats" role="tablist"></div>' +
      '<div class="ml-list"></div>' +
      '<p class="ml-empty" hidden>No models match. Try a different word or category.</p>' +
      '</div>' +
      '<div class="row actions"><span class="grow"></span><button type="button" class="ml-close">Close</button></div>';
    document.body.appendChild(dlg);

    const catWrap = dlg.querySelector('.ml-cats');
    ['All'].concat(DATA.categories).forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ml-cat'; b.textContent = c; b.dataset.cat = c;
      b.onclick = () => { activeCat = c; render(); };
      catWrap.appendChild(b);
    });
    dlg.querySelector('.ml-close').onclick = () => dlg.close();
    dlg.querySelector('.ml-search').addEventListener('input', render);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  }

  function render() {
    const q = (dlg.querySelector('.ml-search').value || '').trim().toLowerCase();
    for (const b of dlg.querySelectorAll('.ml-cat')) b.classList.toggle('active', b.dataset.cat === activeCat);
    const items = DATA.models.filter((m) =>
      (activeCat === 'All' || m.cat === activeCat) &&
      (!q || (m.name + ' ' + m.desc + ' ' + m.cat + ' ' + m.formula).toLowerCase().includes(q)));
    dlg.querySelector('.ml-empty').hidden = items.length > 0;
    let html = '', lastCat = null;
    for (const m of items) {
      if (m.cat !== lastCat) { html += '<h3 class="ml-cat-head">' + esc(m.cat) + '</h3>'; lastCat = m.cat; }
      const guide = (m.guide && m.guide.length)
        ? '<details class="ml-guide"><summary>How to estimate these guesses</summary><ul>' +
            m.guide.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul></details>'
        : '';
      html += '<div class="ml-card">' +
        '<div class="ml-card-main">' +
        '<div class="ml-name">' + esc(m.name) + '</div>' +
        '<p class="ml-desc">' + esc(m.desc) + '</p>' +
        '<div class="ml-meta"><code class="ml-formula">' + esc(m.formula) + '</code>' +
        '<span class="ml-axes">' + esc(m.x) + ' → ' + esc(m.y) + '</span></div>' +
        guide +
        '</div>' +
        '<button type="button" class="ml-use">Use</button>' +
        '</div>';
    }
    dlg.querySelector('.ml-list').innerHTML = html;
    const btns = dlg.querySelectorAll('.ml-use');
    btns.forEach((b, i) => { b.onclick = () => use(items[i]); });
  }

  function use(m) {
    last = m;
    if (typeof applyFunctionExample === 'function') {
      applyFunctionExample([m.formula, m.params, m.guesses].join('|'));
    } else {
      if ($('formula')) $('formula').value = m.formula;
      if ($('param-names')) $('param-names').value = m.params;
      if ($('initial-guesses')) $('initial-guesses').value = m.guesses;
    }
    dlg.close();
    if (typeof showMessage === 'function') showMessage('info', 'Model loaded. Open "Help with parameters" for how to estimate the starting guesses, then press Fit.');
  }

  // The model whose formula matches `formula` — preferring the one just inserted
  // from the library, so distinct experiments that share a formula (a straight
  // line, the photoelectric effect, Compton scattering) keep their own guidance.
  function guideFor(formula) {
    const f = norm(formula);
    if (!f) return null;
    if (last && norm(last.formula) === f) return last;
    return DATA.models.find((m) => norm(m.formula) === f) || null;
  }

  function open() {
    if (!dlg) build();
    activeCat = 'All';
    dlg.querySelector('.ml-search').value = '';
    render();
    dlg.showModal();
  }

  window.ModelLibrary = { open, guideFor };

  function initButton() {
    const btn = document.getElementById('model-library-btn');
    if (btn) btn.onclick = open;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initButton);
  else initButton();
})();
