"""One persistent ROOT interpreter per CLI session, run inside the CLI container."""
import ctypes
import json
import os
import resource
import sys
import tempfile

# Bound runaway output/files; the container supplies memory/CPU/process limits.
resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024, 32 * 1024 * 1024))
import ROOT
ROOT.gROOT.SetBatch(True)
ROOT.gStyle.SetOptStat(0)
ROOT.gStyle.SetOptFit(1111)
protocol = os.fdopen(os.dup(1), 'w', buffering=1)
libc = ctypes.CDLL(None)

def reply(value):
    protocol.write(json.dumps(value, allow_nan=False) + '\n')

def sample_functions(obj, visited=None):
    """Preserve native callable functions that JSROOT cannot evaluate as formulas."""
    visited = set() if visited is None else visited
    address = ROOT.addressof(obj)
    if address in visited:
        return
    visited.add(address)
    if obj.InheritsFrom('TF1'):
        ymin, ymax = (obj.GetYmin(), obj.GetYmax()) if obj.InheritsFrom('TF2') else (0, 0)
        zmin, zmax = (obj.GetZmin(), obj.GetZmax()) if obj.InheritsFrom('TF3') else (0, 0)
        obj.Save(obj.GetXmin(), obj.GetXmax(), ymin, ymax, zmin, zmax)
    for method in ('GetListOfPrimitives', 'GetListOfFunctions'):
        if hasattr(obj, method):
            children = getattr(obj, method)()
            if children:
                for child in children:
                    sample_functions(child, visited)

reply({'ready': True, 'root_version': str(ROOT.gROOT.GetVersion())})
for line in sys.stdin:
    request = json.loads(line)
    error = ctypes.c_int(0)
    canvases, notes = [], []
    saved = [os.dup(1), os.dup(2)]
    with tempfile.TemporaryFile(mode='w+b') as capture:
        try:
            libc.fflush(None)
            os.dup2(capture.fileno(), 1)
            os.dup2(capture.fileno(), 2)
            ROOT.gROOT.ProcessLine(request['code'], error)
            for canvas in list(ROOT.gROOT.GetListOfCanvases()):
                try:
                    canvas.Modified()
                    canvas.Update()
                    sample_functions(canvas)
                    obj = json.loads(str(ROOT.TBufferJSON.ToJSON(canvas)), parse_constant=lambda _: None)
                    canvases.append({'name': str(canvas.GetName()), 'title': str(canvas.GetTitle()), 'json': obj})
                except Exception:
                    notes.append(f'{canvas.GetName()}: ROOT could not serialize this canvas for the browser.')
        except Exception as exc:
            error.value = error.value or 1
            notes.append(str(exc))
        finally:
            libc.fflush(None)
            for target, original in zip((1, 2), saved):
                os.dup2(original, target)
                os.close(original)
        size = capture.seek(0, 2)
        capture.seek(max(0, size - 256_000))
        output = capture.read().decode('utf-8', errors='replace')
        if size > 256_000:
            output = '[Earlier output omitted; showing the last 256 KB.]\n' + output
    reply({'ok': error.value == 0, 'error_code': error.value, 'output': output,
           'canvases': canvases, 'notes': notes})
