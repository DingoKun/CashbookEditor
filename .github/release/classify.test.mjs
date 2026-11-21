import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {classifyDirectories} from './classify.mjs';

const baseline = `<!doctype html>
<!--
  SW2.5 Balance Item Editor
  version: v1.2.3
  date: 2026-01-01
-->
<html><head><title>Example v1.2.3</title><style>
    :root {
      --accent: #123456;
    }
  </style></head><body><span class="version">v1.2.3</span>
<div id="helpModal" title="a > b"><p>Example help.</p></div>
<div id="changelogModal" class="modal"><h3>v1.2.3</h3><p class="changelogDate">2026-01-01</p><ul><li>New.</li></ul></div>
<textarea id="data">value</textarea><button value="x">Save</button>
  <script>
    const VERSION = "v1.2.3";
    const s = '<p>Example help.</p>';
    localStorage.getItem("dict");
  </script></body></html>`;
const pub = ['index.html','README.md','CHANGELOG.md','RELEASE_OVERVIEW.md'];
function withCheckouts(fn) {
  const tmp=fs.mkdtempSync(path.join(process.env.TEST_TMPDIR||os.tmpdir(),'release-classifier-'));
  const a=path.join(tmp,'a'), b=path.join(tmp,'b');
  try {
    for (const dir of [a,b]) {
      fs.mkdirSync(dir);
      for (const file of pub) fs.writeFileSync(path.join(dir,file), file==='index.html'?baseline:'Example.');
    }
    return fn(a,b);
  } finally {
    if (!path.basename(tmp).startsWith('release-classifier-') || path.dirname(tmp)!==path.resolve(process.env.TEST_TMPDIR||os.tmpdir())) throw Error('Bad scratch location.');
    fs.rmSync(tmp,{recursive:true,force:true});
  }
}
function check(fn, decision) {
  return withCheckouts((a,b)=>{fn(a,b);const actual=classifyDirectories(a,b);assert.equal(actual.decision,decision,JSON.stringify(actual));return actual;});
}
const html=(transform,expected)=>check((a,b)=>fs.writeFileSync(path.join(b,pub[0]),transform(baseline)),expected);
test('unchanged content and approved documentation are eligible',()=>{
  check(()=>{},'auto');check((a,b)=>fs.writeFileSync(path.join(b,pub[1]),'Updated usage.'),'auto');
});
test('plain help text, existing theme color and synchronized patch version',()=>{
  html(s=>s.replace('Example help.','Updated help.'),'auto');
  html(s=>s.replace('#123456','#AABBCC'),'auto');
  html(s=>s.replaceAll('v1.2.3','v1.3.0').replaceAll('2026-01-01','2026-01-02'),'auto');
});
test('reject malformed, mismatched or decreased versions',()=>{
  html(s=>s.replaceAll('v1.2.3','v1.0.3'),'review');
  html(s=>s.replace('const VERSION = "v1.2.3"','const VERSION = "v1.2.4"'),'review');
  html(s=>s.replaceAll('v1.2.3','v01.2.3'),'review');
});
test('reject changes to executable code, including apparent text inside code',()=>{
  html(s=>s.replace('getItem("dict")','getItem("dict2")'),'review');
  html(s=>s.replace('const s = \'<p>Example help.</p>\'','const s = \'<p>New help.</p>\''),'review');
  html(s=>s.replace('const VERSION =','let VERSION ='),'review');
  html(s=>s.replace('  </script>','  </script><script>void 0;</script>'),'review');
});
test('reject any attribute, interactive data, structure or unclassified style change',()=>{
  html(s=>s.replace('value="x"','value="y"'),'review');
  html(s=>s.replace('title="a > b"','title="a > c"'),'review');
  html(s=>s.replace('id="data">value','id="data">lost'),'review');
  html(s=>s.replace('>Example help.</p>','><b>Example</b></p>'),'review');
  html(s=>s.replace('>Save</button>','>Erase</button>'),'review');
  html(s=>s.replace('#123456','var(--warning)'),'review');
  html(s=>s.replace('#123456','#123456; display:none'),'review');
  html(s=>s.replace('Example help.','&#60;script&#62;'),'review');
});
test('unknown material, missing assets, and nonidentical controls always require review',()=>{
  check((a,b)=>fs.unlinkSync(path.join(b,pub[2])),'review');
  check((a,b)=>fs.writeFileSync(path.join(b,'private.csv'),'example'),'review');
  const r=check((a,b)=>{for (const dir of [a,b]) fs.mkdirSync(path.join(dir,'.github'));fs.writeFileSync(path.join(b,'.github','control.mjs'),'0');},'review');
  assert.equal(r.controlChanged,true);
});

test('the approved real HTML accepts an isolated theme color change and rejects a storage-key change',
  {skip:!process.env.RELEASE_BASE_HTML},()=>{
  const html=fs.readFileSync(process.env.RELEASE_BASE_HTML,'utf8');
  const safe=html.replace(/(--accent: )#[a-fA-F0-9]{6}/,'$1#00cc99');
  const unsafe=html.replace('localStorage.getItem(', 'sessionStorage.getItem(');
  assert.notEqual(safe,html); assert.notEqual(unsafe,html);
  for (const [value,decision] of [[safe,'auto'],[unsafe,'review']])
    check((a,b)=>{fs.writeFileSync(path.join(a,pub[0]),html);fs.writeFileSync(path.join(b,pub[0]),value);},decision);
});
