/* A deliberately bounded expression grammar: never evaluates user code.
 * MathLive supplies editing/typesetting; this module defines the scientific
 * meaning of supported LaTeX and translates it to ROOT TFormula syntax. */
(function (scope) {
  'use strict';
  const greek = new Set('alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Sigma Upsilon Phi Psi Omega'.split(' '));
  const functions = {sin:[1,'sin'],cos:[1,'cos'],tan:[1,'tan'],asin:[1,'asin'],acos:[1,'acos'],atan:[1,'atan'],arcsin:[1,'asin'],arccos:[1,'acos'],arctan:[1,'atan'],sinh:[1,'sinh'],cosh:[1,'cosh'],tanh:[1,'tanh'],exp:[1,'exp'],ln:[1,'log'],log:[1,'log'],log10:[1,'log10'],sqrt:[1,'sqrt'],abs:[1,'abs'],erf:[1,'TMath::Erf'],erfc:[1,'TMath::Erfc'],pow:[2,'pow'],min:[2,'TMath::Min'],max:[2,'TMath::Max'],atan2:[2,'atan2']};
  const fail = message => { throw new Error(message); };
  function tokens(latex) {
    const source = latex.replace(/\\(?:left|right|bigl|bigr|Bigl|Bigr)\b/g,'').replace(/\\(?:,|;|!| |quad\b|qquad\b)/g,' ');
    let i = 0; const out = [];
    while (i < source.length) {
      const rest = source.slice(i); let m;
      if (/^\s/.test(rest)) { i++; continue; }
      if ((m = rest.match(/^\\(mathrm|mathit|operatorname|text)\s*\{([A-Za-z][A-Za-z0-9_]*)\}/))) {
        const name=m[2];
        if (m[1] === 'operatorname' && !functions[name]) fail(`The equation editor does not support the function ${name}. Use ROOT expression mode for other functions.`);
        out.push({t: functions[name] ? 'fn' : name === 'e' || name === 'pi' ? 'constant' : 'symbol', v:name}); i += m[0].length; continue;
      }
      if ((m = rest.match(/^\\([A-Za-z]+)/))) {
        const v = m[1]; i += m[0].length;
        if (v === 'placeholder' || v === 'error') fail('Complete the empty field in the equation before fitting.');
        if (greek.has(v)) out.push({t:'symbol',v});
        else if (v === 'pi') out.push({t:'constant',v});
        else if (v === 'cdot' || v === 'times') out.push({t:'*'});
        else if (v === 'div') out.push({t:'/'});
        else if (v === 'frac' || v === 'dfrac' || v === 'tfrac') out.push({t:'frac'});
        else if (v === 'sqrt') out.push({t:'sqrt'});
        else if (v === 'lvert' || v === 'rvert' || v === 'vert') out.push({t:'|'});
        else if (functions[v]) out.push({t:'fn',v});
        else fail(`The equation editor does not support \\${v}. Use ROOT expression mode for this function or notation.`);
        continue;
      }
      if ((m = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/))) { out.push({t:'number',v:m[0]}); i += m[0].length; continue; }
      if ((m = rest.match(/^(arcsin|arccos|arctan|log10|atan2|sinh|cosh|tanh|sqrt|sin|cos|tan|asin|acos|atan|exp|ln|log|abs|erfc|erf|pow|min|max)(?=[({])/))) { out.push({t:'fn',v:m[1]}); i += m[0].length; continue; }
      const c = source[i++];
      if (/[A-Za-z]/.test(c)) out.push({t:c === 'e' ? 'constant':'symbol',v:c});
      else if ('+-*/^_(){}[],|='.includes(c)) out.push({t:c});
      else if (c === '−') out.push({t:'-'});
      else if (c === 'π') out.push({t:'constant',v:'pi'});
      else fail(`“${c}” is not supported in a fit expression. Use arithmetic, functions, and parameter symbols.`);
    }
    if (out.length > 1500) fail('This equation is too long for the equation editor. Use ROOT expression mode.');
    out.push({t:'end'}); return out;
  }
  function parse(latex) {
    const ts = tokens(latex); let at = 0, depth = 0;
    const peek = () => ts[at].t;
    const take = t => { if (peek() !== t) fail(`Expected ${t === 'end' ? 'the end of the expression' : '“'+t+'”'}. Check parentheses and incomplete terms.`); return ts[at++]; };
    const binary = (op,a,b) => ({k:'binary',op,a,b});
    function expression() {
      if (++depth > 100) fail('The equation has too many nested terms.');
      let a = product();
      while (peek() === '+' || peek() === '-') { const op = ts[at++].t; a = binary(op,a,product()); }
      depth--; return a;
    }
    function product() {
      let a = unary();
      while (true) {
        if (peek() === '*' || peek() === '/') { const op=ts[at++].t; a=binary(op,a,unary()); }
        else if (['number','symbol','constant','fn','frac','sqrt','(','{'].includes(peek())) a=binary('*',a,unary());
        else break;
      }
      return a;
    }
    function unary() {
      if (peek() === '+' || peek() === '-') { const op=ts[at++].t; return {k:'unary',op,a:unary()}; }
      let a=atom();
      if (peek() === '^') { at++; a=binary('^',a,unary()); }
      return a;
    }
    function group() {
      const open=ts[at++].t, close={'{':'}','(':')','[':']'}[open];
      if (!close) fail('Add parentheses or braces around this argument.');
      const a=expression(); take(close); return a;
    }
    function subscript() {
      at++; let parts=[];
      if (peek() === '{') { at++; while (['number','symbol'].includes(peek())) parts.push(ts[at++].v); take('}'); }
      else if (['number','symbol'].includes(peek())) parts.push(ts[at++].v);
      else fail('Complete the parameter subscript.');
      if (!parts.length) fail('Complete the parameter subscript.');
      return parts.join('');
    }
    function atom() {
      const token=ts[at++];
      if (token.t === 'number') {
        if (!Number.isFinite(Number(token.v))) fail('Numeric constants must be finite.');
        return {k:'number',v:token.v};
      }
      if (token.t === 'constant') {
        if (peek() === '_') fail('e and π are reserved constants. Use another parameter symbol.');
        return {k:'constant',v:token.v};
      }
      if (token.t === 'symbol') {
        let v=token.v;
        if (peek() === '_') v+='_'+subscript();
        return {k:'symbol',v};
      }
      if (token.t === '(' || token.t === '{') { at--; return group(); }
      if (token.t === 'frac') return binary('/',group(),group());
      if (token.t === 'sqrt') {
        let degree=null; if (peek() === '[') degree=group();
        const a=group(); return degree ? binary('^',a,binary('/',{k:'number',v:'1'},degree)) : {k:'call',v:'sqrt',args:[a]};
      }
      if (token.t === '|') { const a=expression(); take('|'); return {k:'call',v:'abs',args:[a]}; }
      if (token.t === 'fn') {
        let power=null;
        if (peek() === '^') { at++; power=peek() === '{' ? group() : atom(); }
        if (peek() !== '(' && peek() !== '{') fail(`Put the argument of ${token.v} in parentheses, for example ${token.v}(x).`);
        const close=ts[at++].t === '(' ? ')' : '}'; const args=[expression()];
        while (peek() === ',') { at++; args.push(expression()); }
        take(close);
        if (args.length !== functions[token.v][0]) fail(`${token.v} takes ${functions[token.v][0]} argument(s).`);
        const call={k:'call',v:token.v,args};
        return power ? binary('^',call,power) : call;
      }
      fail(token.t === 'end' ? 'Complete the equation before fitting.' : `Unexpected “${token.t}”. Check for an empty field or a missing term.`);
    }
    if (ts[0].t === 'symbol' && ts[0].v === 'y' && ts[1].t === '=') at=2;
    const ast=expression(); take('end'); return ast;
  }
  function symbols(ast, out=[]) {
    if (ast.k === 'symbol' && ast.v !== 'x' && !out.includes(ast.v)) out.push(ast.v);
    if (ast.a) symbols(ast.a,out); if (ast.b) symbols(ast.b,out);
    for (const a of ast.args || []) symbols(a,out); return out;
  }
  function emit(ast, parameters) {
    if (ast.k === 'number') return ast.v;
    if (ast.k === 'constant') return ast.v === 'pi' ? 'TMath::Pi()' : 'exp(1)';
    if (ast.k === 'symbol') return ast.v === 'x' ? 'x' : `[${parameters.indexOf(ast.v)}]`;
    if (ast.k === 'unary') return `(${ast.op}${emit(ast.a,parameters)})`;
    if (ast.k === 'binary') return `(${emit(ast.a,parameters)}${ast.op}${emit(ast.b,parameters)})`;
    return `${functions[ast.v][1]}(${ast.args.map(a=>emit(a,parameters)).join(',')})`;
  }
  function compile(latex, previous=[]) {
    const ast=parse(latex), found=symbols(ast);
    const parameters=[...new Set(previous.filter(s=>found.includes(s))), ...found.filter(s=>!previous.includes(s))];
    if (parameters.length > 100) fail('Use at most 100 fit parameters.');
    return {formula:emit(ast,parameters),parameters};
  }
  function symbolLatex(name) {
    const split=name.indexOf('_'); const base=split<0?name:name.slice(0,split), sub=split<0?'':name.slice(split+1);
    const text=greek.has(base)?'\\'+base:base.length===1?base:'\\mathrm{'+base+'}';
    return text+(sub?'_{'+sub+'}':'');
  }
  // Render the parsed expression, rather than substituting text into LaTeX.
  // Braced exponents and fractions preserve grouping when MathLive reparses it.
  function toLatex(ast) {
    const wrap=a=>'\\left('+toLatex(a)+'\\right)';
    const precedence=a=>a.k==='number' && /[eE]/.test(a.v) ? 2 : a.k==='binary' ? ({'+':1,'-':1,'*':2,'/':2,'^':4}[a.op]) : a.k==='unary'?3:5;
    if(ast.k==='number') {
      const sci=ast.v.match(/^(.+)[eE]([+-]?\d+)$/);
      return sci ? sci[1]+'\\cdot 10^{'+String(Number(sci[2]))+'}' : ast.v;
    }
    if(ast.k==='symbol') return symbolLatex(ast.v);
    if(ast.k==='constant') return ast.v==='pi'?'\\pi':'e';
    if(ast.k==='unary') return ast.op+(precedence(ast.a)<3?wrap(ast.a):toLatex(ast.a));
    if(ast.k==='call') {
      if(ast.v==='sqrt') return '\\sqrt{'+toLatex(ast.args[0])+'}';
      if(ast.v==='pow') return toLatex({k:'binary',op:'^',a:ast.args[0],b:ast.args[1]});
      return '\\operatorname{'+ast.v+'}\\left('+ast.args.map(toLatex).join(', ')+'\\right)';
    }
    if(ast.op==='/') return '\\frac{'+toLatex(ast.a)+'}{'+toLatex(ast.b)+'}';
    if(ast.op==='^') return (precedence(ast.a)<5?wrap(ast.a):toLatex(ast.a))+'^{'+toLatex(ast.b)+'}';
    const level=precedence(ast);
    const left=precedence(ast.a)<level?wrap(ast.a):toLatex(ast.a);
    const right=precedence(ast.b)<level || (ast.op==='-' && precedence(ast.b)===level) || ast.b.k==='unary' ? wrap(ast.b):toLatex(ast.b);
    return left+(ast.op==='*'?' \\cdot ':' '+ast.op+' ')+right;
  }
  // Conservative import: ROOT-only formulas remain editable in ROOT mode.
  // Existing ROOT text stays canonical until the user actually edits the equation.
  function fromRoot(formula, names=[]) {
    let source=formula.trim();
    if (/\bx\s*\[/.test(source)) fail('Use ROOT expression mode for multidimensional variables.');
    source=source.replace(/TMath::(Exp|Log10|Log|Sqrt|Sin|Cos|Tan|ASin|ACos|ATan|SinH|CosH|TanH|Abs|Power)(?=\s*\()/g,(_,name)=>({ASin:'asin',ACos:'acos',ATan:'atan',SinH:'sinh',CosH:'cosh',TanH:'tanh',Power:'pow'}[name] || name.toLowerCase()));
    const aliases={gaus:'[0]*exp(-0.5*((x-[1])/[2])^2)',gausn:'[0]/(sqrt(2*TMath::Pi())*[2])*exp(-0.5*((x-[1])/[2])^2)',expo:'exp([0]+[1]*x)'};
    source=source.replace(/\b(gausn|gaus|expo|pol\d+)(?:\((\d+)\))?/g, (m,name,offset)=>{
      const off=Number(offset||0);
      const expr=name.startsWith('pol') ? Array.from({length:Math.min(Number(name.slice(3))+1,101)},(_,i)=>i===0?'[0]':i===1?'[1]*x':`[${i}]*x^${i}`).join('+') : aliases[name];
      return '('+expr.replace(/\[(\d+)\]/g,(_,n)=>`[${Number(n)+off}]`)+')';
    });
    const matches=[...source.matchAll(/\[(\d+)\]/g)].map(m=>Number(m[1]));
    const n=matches.length?Math.max(...matches)+1:0;
    if(n>100) fail('Use ROOT expression mode for this formula.');
    const parameters=[];
    for(let i=0;i<n;i++) {
      let name=names[i] || (n<=3?['a','b','c'][i]:`p_${i}`);
      if(!/^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)?$/.test(name) || ['x','e','pi'].includes(name) || functions[name] || parameters.includes(name)) name=`p_${i}`;
      while(parameters.includes(name)) name+='a';
      parameters.push(name);
    }
    source=source.replace(/TMath::Pi\(\)/g,'\\pi ');
    const rootFns=Object.entries(functions).sort((a,b)=>b[1][1].length-a[1][1].length);
    for(const [name,[,root]] of rootFns) {
      source=source.replace(new RegExp('(?<![A-Za-z\\\\])'+root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=\\s*\\()','g'),()=>`\\operatorname{${name}}`);
    }
    source=source.replace(/\[(\d+)\]/g,(_,i)=>symbolLatex(parameters[Number(i)])+' ').replace(/\*/g,'\\cdot ');
    // ROOT integer powers without braces are valid LaTeX only for a single digit.
    source=source.replace(/\^(-?\d+(?:\.\d+)?)/g,'^{$1}');
    const compiled=compile(source,parameters);
    if(compiled.parameters.length!==n) fail('Use ROOT expression mode for this formula.');
    return {latex:toLatex(parse(source)),parameters};
  }
  function symbolLabel(name) {
    const names='alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Sigma Upsilon Phi Psi Omega'.split(' ');
    const chars=Array.from('αβγδεεζηθϑικλμνξρϱσςτυϕφχψωΓΔΘΛΞΣΥΦΨΩ');
    return name.replace(/^[A-Za-z]+/,base=>names.includes(base)?chars[names.indexOf(base)]:base);
  }
  // Reuse the bounded grammar for worksheet calculations without executing code.
  function expression(latex) {
    const ast=parse(latex), variables=[];
    function visit(a) {
      if(a.k==='symbol' && !variables.includes(a.v)) variables.push(a.v);
      if(a.a) visit(a.a); if(a.b) visit(a.b);
      for(const child of a.args || []) visit(child);
    }
    visit(ast);
    function evaluate(values) {
      function walk(a) {
        if(a.k==='number') return Number(a.v);
        if(a.k==='constant') return a.v==='pi'?Math.PI:Math.E;
        if(a.k==='symbol') { if(!Number.isFinite(values[a.v])) fail('Assign a finite value to '+a.v+'.'); return values[a.v]; }
        if(a.k==='unary') return a.op==='-'?-walk(a.a):walk(a.a);
        if(a.k==='binary') {
          const l=walk(a.a), r=walk(a.b);
          return a.op==='+'?l+r:a.op==='-'?l-r:a.op==='*'?l*r:a.op==='/'?l/r:l**r;
        }
        const name={ln:'log',arcsin:'asin',arccos:'acos',arctan:'atan'}[a.v] || a.v;
        if(typeof Math[name]!=='function') fail('This calculation does not support '+a.v+'.');
        return Math[name](...a.args.map(walk));
      }
      const answer=walk(ast);
      if(!Number.isFinite(answer)) fail('The expression is undefined for these inputs. Check denominators and function domains.');
      return answer;
    }
    return {variables,evaluate,ast};
  }
  const api={compile,fromRoot,symbolLatex,symbolLabel,expression};
  if(typeof module==='object' && module.exports) module.exports=api;
  else scope.RootEquation=api;
})(globalThis);
