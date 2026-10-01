// Editing over characters the app inserts itself: digit grouping, the
// managed indent, the "// " space, old U+00A0 padding. Backspace / Delete
// must never stop on them or drag them along — on a real keyboard and on a
// soft keyboard (beforeinput only, as Android sends it). Prints PASS/FAIL.
//   node edittest.js <path-to-index.html>
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');

const EXE = path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');
(async()=>{
  const b=await chromium.launch({executablePath:EXE}); let fails=0; const ok=(c,m)=>{ console.log((c?'  ok  ':'  FAIL')+' '+m); if(!c) fails++; };
  const p=await b.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  for(const u of ['**://www.gstatic.com/**','**://*.googleapis.com/**','**://www.cbr-xml-daily.ru/**']) await p.route(u,r=>r.abort());
  await p.goto('file://'+path.resolve(process.argv[2]||path.join(os.homedir(),'calcuta/index.html'))); await p.waitForFunction(()=>window.__calcuta);
  await p.evaluate(()=>{ const g=document.getElementById('authgate'); if(g){ g.classList.remove('show'); g.style.display='none'; }
    // helpers in page: core text (no digit grouping) + caret as a core offset
    window.T={
      el:document.getElementById('input'),
      core(){ const v=this.el.value, c=this.el.selectionStart; return {t:v.replace(/ /g,'').replace(/^ +/gm,''), c:v.slice(0,c).replace(/ /g,'').replace(/^ +/gm,'').length, osp:v.includes(' ')}; },
      set(t, coreCaret){ const el=this.el; el.focus(); el.value=t; el.setSelectionRange(t.length,t.length); el.dispatchEvent(new Event('input',{bubbles:true}));
        if(coreCaret!=null){ const v=el.value; let k=0,c=0; const lines=v.split('\n'); // map core offset (no grouping, no indent) back to a raw offset
          let raw=0; for(const L of lines){ const ind=L.match(/^ */)[0].length; let i=0; raw+=ind; while(i<L.length-ind){ if(c===coreCaret) break; if(L[ind+i]!==' ') c++; i++; raw++; } if(c===coreCaret && i<L.length-ind) break; if(c===coreCaret){ break; } raw++; c++; }
          el.setSelectionRange(raw,raw); } },
      soft(type, cancelable=true){ const el=this.el;
        const notCancelled=el.dispatchEvent(new InputEvent('beforeinput',{inputType:type,cancelable,bubbles:true}));
        if(notCancelled){ const v=el.value,c=el.selectionStart, back=type==='deleteContentBackward'; el.value=back?v.slice(0,c-1)+v.slice(c):v.slice(0,c)+v.slice(c+1); el.setSelectionRange(back?c-1:c,back?c-1:c); el.dispatchEvent(new InputEvent('input',{inputType:type,bubbles:true})); } }
    }; });
  const core=()=>p.evaluate(()=>T.core());
  const step=async(label, pre, caret, actions, expects)=>{ await p.evaluate(([t,c])=>T.set(t,c),[pre,caret]); let i=0;
    for(const a of actions){ if(a.startsWith('soft:')) await p.evaluate(x=>T.soft(x),a.slice(5)); else if(a.startsWith('softNC:')) await p.evaluate(x=>T.soft(x,false),a.slice(7)); else if(a.startsWith('type:')) await p.keyboard.type(a.slice(5)); else if(a.startsWith('ins:')) await p.keyboard.insertText(a.slice(4)); else await p.keyboard.press(a);
      const c=await core(); const [et,ec]=expects[i++]; const good=c.t===et && c.c===ec && !c.osp;
      ok(good, `${label} [${a}] -> ${JSON.stringify(c.t.slice(0,c.c)+'|'+c.t.slice(c.c))}${c.osp?' (U+00A0 left!)':''}${good?'':'  want '+JSON.stringify(et.slice(0,ec)+'|'+et.slice(ec))}`); } };
  console.log('— keyboard —');
  await step('your case "700()": Backspace x4', '500+200/700()', null, ['Backspace','Backspace','Backspace','Backspace'], [['500+200/700(',12],['500+200/700',11],['500+200/70',10],['500+200/7',9]]);
  await step('Delete before grouping "12|·345"', '12345', 2, ['Delete','Delete'], [['1245',2],['125',2]]);
  await step('Backspace after grouping "12·|345"', '12345', 2, ['Backspace'], [['1345',1]]);
  await step('Ctrl+Backspace on a grouped number', 'сумма 12345', null, ['Control+Backspace'], [['сумма ',6]]);
  await step('Delete at end of a heading line', '# A\nтекст', 3, ['Delete'], [['# Aтекст',3]]);
  await step('Backspace at content start of indented line', '# A\nтекст', 4, ['Backspace'], [['# Aтекст',3]]);
  await step('typing "1343()" leaves no padding', '', 0, ['type:1343()'], [['1343()',6]]);
  await step('Option+Space no-break space -> plain space', 'слово', null, ['ins: ','type:x'], [['слово ',6],['слово x',7]]);
  console.log('— phone (soft keyboard: beforeinput only) —');
  await step('Backspace after "// " removes the space', '// текст', 3, ['soft:deleteContentBackward'], [['//текст',2]]);
  await step('Backspace after grouping "12·|345"', '12345', 2, ['soft:deleteContentBackward'], [['1345',1]]);
  await step('Delete before grouping "12|·345"', '12345', 2, ['soft:deleteContentForward'], [['1245',2]]);
  await step('Backspace at content start merges lines', '# A\nтекст', 4, ['soft:deleteContentBackward'], [['# Aтекст',3]]);
  await step('Backspace in "(|)" deletes both', '', 0, ['type:(','soft:deleteContentBackward'], [['()',1],['',0]]);
  await step('non-cancelable delete is left to the browser', 'abc', null, ['softNC:deleteContentBackward'], [['ab',2]]);
  console.log('— legacy text & math —');
  const leg=await p.evaluate(()=>{ T.set('x = 2 + 2 и 1343 () слово слово'); const c=T.core(); return {t:c.t, osp:c.osp, r:window.__calcuta.analyze(T.el.value).lines[0].result}; });
  ok(leg.t==='x=2+2 и 1343() слово слово' && !leg.osp, 'legacy padding dropped, other no-break space -> space: '+JSON.stringify(leg.t));
  const nd=await p.evaluate(()=>{ const r={docs:[{id:'q',text:'500 / 3 () a b',updated:1,markup:2}]}; window.__calcuta.normalizeStoreDocs(r); return r.docs[0].text; });
  ok(nd==='500/3() a b', 'stored docs cleaned the same way: '+JSON.stringify(nd));
  const m=await p.evaluate(()=>{ T.set('1343()\n500/3()\n(2+3)*4\nитого()=1000*1,25'); return window.__calcuta.analyze(T.el.value).lines.map(l=>l.result); });
  ok(JSON.stringify(m)==='[1350,170,20,1250]', 'round marker and math unchanged: '+JSON.stringify(m));
  await p.evaluate(()=>T.set('# A\nтекст',3)); await p.waitForTimeout(700); await p.keyboard.press('Delete'); await p.waitForTimeout(700); await p.keyboard.press('Control+z');
  const u=await core(); ok(u.t==='# A\nтекст', 'Ctrl+Z restores a Delete-join: '+JSON.stringify(u.t));
  ok(!errs.length, 'no page errors '+(errs.length?errs:''));
  await b.close(); console.log(fails?`\n${fails} FAILED`:'\nALL SEPARATOR CHECKS PASSED');
})();
