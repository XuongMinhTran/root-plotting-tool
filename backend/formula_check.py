"""
formula_check.py — decide whether a formula string is safe to hand to ROOT.

Why this exists: ROOT's TFormula compiles the formula text into real C++ with
Cling. Whatever a visitor types ends up inside a C++ function on the server,
so we only accept a small, known vocabulary. Everything else is rejected with
a message that says exactly which piece was not allowed.

The check works like a tiny tokenizer: it walks through the string, matching
one piece at a time (a number, a parameter like [0], a function name, an
operator, ...). If a piece matches nothing on the allow-list, that is an error.
It never tries to *evaluate* anything — ROOT still does the real parsing.

Usage:
    from formula_check import check_formula
    ok, message = check_formula("[0]*exp(-x/[1])")
"""

import re

MAX_LENGTH = 500

# Plain C-style math functions TFormula understands.
FUNCTIONS = {
    "exp", "log", "log10", "sqrt", "pow", "abs",
    "sin", "cos", "tan", "asin", "acos", "atan",
    "sinh", "cosh", "tanh",
}

# TMath:: functions we allow. Names are case-sensitive, as in ROOT.
TMATH_FUNCTIONS = {
    # elementary
    "Exp", "Log", "Log2", "Log10", "Sqrt", "Power", "Abs", "Sq", "Hypot",
    "Sin", "Cos", "Tan", "ASin", "ACos", "ATan", "ATan2",
    "SinH", "CosH", "TanH", "ASinH", "ACosH", "ATanH",
    "Floor", "Ceil", "Nint", "Sign", "Min", "Max",
    # constants (called with empty parentheses, e.g. TMath::Pi())
    "Pi", "TwoPi", "PiOver2", "PiOver4", "E", "Ln10", "LogE", "Sqrt2",
    "DegToRad", "RadToDeg", "C", "H", "Hbar", "K", "Na", "Qe", "G", "Sigma",
    # special functions and distributions
    "Gaus", "Landau", "Erf", "Erfc", "Gamma", "LnGamma", "Beta",
    "Freq", "Poisson", "PoissonI", "Binomial", "BreitWigner", "Voigt",
    "CauchyDist", "LaplaceDist", "LogNormal", "Student", "ChisquareQuantile",
    "BesselI0", "BesselI1", "BesselJ0", "BesselJ1", "BesselK0", "BesselK1",
    "BesselY0", "BesselY1", "StruveH0", "StruveH1",
}

# ROOT's built-in named functions (usable alone, "gaus", or in sums with a
# parameter offset, "gaus(0)+pol1(3)"). polN / chebyshevN take any N.
NAMED_FUNCTIONS = {
    "gaus", "gausn", "expo", "landau", "landaun",
    "crystalball", "crystalballn", "breitwigner",
}
NAMED_FUNCTION_PATTERNS = [re.compile(r"^pol\d+$"), re.compile(r"^chebyshev\d+$")]

# Constants TFormula knows by name.
CONSTANTS = {"pi"}

# One regex with a named group per kind of token. Order matters: longer
# operators (<=, &&) must be tried before the single-character ones.
TOKEN = re.compile(r"""
    (?P<space>\s+)
  | (?P<number>(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)
  | (?P<param>\[[A-Za-z0-9_]+\])
  | (?P<tmath>TMath::[A-Za-z0-9_]*)
  | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<op>\*\*|<=|>=|==|!=|&&|\|\||[-+*/^%<>!?:(),])
""", re.VERBOSE)


def check_formula(formula):
    """Return (True, "") if the formula only uses allowed pieces,
    otherwise (False, "<human-readable reason>")."""
    if formula is None or not str(formula).strip():
        return False, "The fit function is empty."
    formula = str(formula)
    if len(formula) > MAX_LENGTH:
        return False, f"The fit function is too long (limit {MAX_LENGTH} characters)."

    depth = 0
    pos = 0
    while pos < len(formula):
        m = TOKEN.match(formula, pos)
        if not m:
            return False, (f"Character {formula[pos]!r} at position {pos + 1} is not allowed. "
                           "Use numbers, x, [0], [1], ..., + - * / ^, parentheses and "
                           "the listed functions.")
        kind = m.lastgroup
        text = m.group(0)
        pos = m.end()

        if kind == "space" or kind == "number" or kind == "param":
            continue

        if kind == "ident":
            if text == "x" or text in CONSTANTS or text in FUNCTIONS or text in NAMED_FUNCTIONS:
                continue
            if any(p.match(text) for p in NAMED_FUNCTION_PATTERNS):
                continue
            hint = ""
            if text in ("y", "z", "t"):
                hint = " Only one variable, x, is supported."
            elif text.lower() in FUNCTIONS:
                hint = f" Did you mean '{text.lower()}'?"
            return False, f"'{text}' is not an allowed name.{hint} Parameters are written [0], [1], ..."

        if kind == "tmath":
            name = text[len("TMath::"):]
            if name in TMATH_FUNCTIONS:
                continue
            return False, f"'{text}' is not on the allowed list of TMath functions."

        if kind == "op":
            if text == "**":
                return False, "Use '^' for powers (for example x^2), not '**'."
            if text == "(":
                depth += 1
            elif text == ")":
                depth -= 1
                if depth < 0:
                    return False, f"Unmatched ')' at position {pos}."
            continue

    if depth != 0:
        return False, "Unbalanced parentheses: there are more '(' than ')'."
    return True, ""


def allowed_summary():
    """Short text for error messages / docs."""
    return {
        "functions": sorted(FUNCTIONS),
        "tmath": sorted(TMATH_FUNCTIONS),
        "named": sorted(NAMED_FUNCTIONS) + ["polN", "chebyshevN"],
        "constants": sorted(CONSTANTS),
    }
