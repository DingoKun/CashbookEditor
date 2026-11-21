// Run this trusted copy against two clean, immutable Git checkouts. No npm packages or network.
// This is a positive list for CSV-compatibility risk, not a substitute for testing or publication review.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const assets = ['CHANGELOG.md','README.md','RELEASE_OVERVIEW.md','index.html'];
const version = 'v(?:0|[1-9][0-9]{0,5})(?:\\.(?:0|[1-9][0-9]{0,5})){2}';
const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const colors = 'bg panel line text muted accent danger section-bg section-open section-border management-bg management-open subrow-bg warn-bg warn-line warn-text warn-marker'.split(' ');
const review = (reason, extra={}) => ({decision:'review',reasons:[reason],...extra});

function files(root) {
  root = path.resolve(root);
  if (!fs.lstatSync(root).isDirectory()) throw Error('Expected a real checkout directory.');
  const map = new Map(); let bytes = 0, count = 0;
  function walk(dir, prefix) {
    if (prefix.split('/').length > 12) throw Error('Unexpected control-tree depth.');
    for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const rel = prefix+entry.name, file = path.join(dir,entry.name);
      if (rel === '.git') continue;
      if (++count > 512) throw Error('Unexpected checkout size.');
      if (!assets.includes(rel) && rel !== '.github' && !rel.startsWith('.github/')) throw Error('Unexpected path outside the public four files and .github.');
      if (entry.isDirectory()) { walk(file,rel+'/'); continue; }
      if (!entry.isFile()) throw Error('Unexpected symlink or special file in checkout.');
      const stat=fs.statSync(file), size=stat.size;
      if (size > 8*1024*1024 || (bytes += size) > 32*1024*1024) throw Error('Checkout exceeds review limits.');
      const data=fs.readFileSync(file);
      map.set(rel, {hash:createHash('sha256').update(data).digest('hex'), executable:Boolean(stat.mode&0o111), data:rel==='index.html'?data:null});
    }
  }
  walk(root,'');
  if (assets.some(name=>!map.has(name))) throw Error('Missing required public asset.');
  return map;
}

// Source tokenizer for the existing single-script template. Copy every tag, attribute, script and
// opaque section verbatim. Ignore only narrowly defined literal values. Reject unfamiliar syntax;
// this is not meant to rewrite arbitrary HTML or to make an untrusted template trustworthy.
function signature(buf) {
  const s = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buf);
  if (s.includes('\0')) throw Error('Unsupported text.');
  const parts=[], stack=[], versions={}; let i=0, scripts=0, styles=0;
  function save(key,value) {
    if (Object.hasOwn(versions,key)) throw Error('Duplicate version marker.');
    versions[key]=value; return '\0';
  }
  const inside=(id)=>stack.some(node=>node.open.startsWith('<div id="'+id+'" '));
  while (i<s.length) {
    const top=stack.at(-1);
    if (s.startsWith('<!--',i)) {
      const end=s.indexOf('-->',i+4);
      if (end===-1) throw Error('Malformed HTML comment.');
      let raw=s.slice(i,end+3);
      if (!stack.length && /^<!--\r?\n  SW2\.5 Balance Item Editor\r?\n/.test(raw)) {
        raw=raw.replace(new RegExp('^(  version: )('+version+')(?=\\r?$)','m'),(_,p,v)=>p+save('header',v))
          .replace(/^(  date: )\d{4}-\d{2}-\d{2}(?=\r?$)/m,'$1\0');
      }
      parts.push(raw); i=end+3; continue;
    }
    if (s[i] !== '<') {
      const end=s.indexOf('<',i); let t=s.slice(i,end<0?s.length:end);
      if (top?.open==='<span class="version">' && new RegExp('^'+version+'$').test(t)) t=save('badge',t);
      else if (inside('changelogModal') && top?.open==='<h3>' && new RegExp('^'+version+'$').test(t)) {
        if (!versions.log) save('log',t);
        t='\0';
      } else if (inside('changelogModal') && top?.open==='<p class="changelogDate">' && /^\d{4}-\d{2}-\d{2}$/.test(t)) t='\0';
      else if (/^[^<>&\u0000-\u001f\u007f]+$/.test(t) && t.trim() && (
        inside('helpModal') && ['<p>','<p class="hint">'].includes(top?.open) ||
        inside('changelogModal') && top?.open==='<li>' && stack.at(-2)?.open==='<ul>')) t='\0';
      parts.push(t); i=end<0?s.length:end; continue;
    }
    let j=i+1, quote='';
    for (;j<s.length;j++) {
      const c=s[j];
      if (quote) { if (c===quote) quote=''; }
      else if (c==='"' || c==="'") quote=c;
      else if (c==='>') break;
      else if (c==='<') throw Error('Unsupported markup.');
    }
    if (j===s.length) throw Error('Unclosed tag.');
    const tag=s.slice(i,j+1); i=j+1; parts.push(tag);
    if (/^<!doctype html>$/i.test(tag)) continue;
    const close=tag.match(/^<\/([a-z][a-z\d-]*)\s*>$/i);
    if (close) {
      if (stack.at(-1)?.name==='option' && ['select','datalist','optgroup'].includes(close[1].toLowerCase())) stack.pop();
      const expected=stack.pop()?.name;
      if (expected!==close[1].toLowerCase()) throw Error('Unsupported element nesting near line '+s.slice(0,i).split('\n').length+' ('+expected+'/'+close[1]+').');
      continue;
    }
    const open=tag.match(/^<([a-z][a-z\d-]*)(?=[\s/>])/i);
    if (!open) throw Error('Unsupported markup.');
    const name=open[1].toLowerCase();
    if (name==='option' && stack.at(-1)?.name==='option') stack.pop();
    if (['script','style','textarea','title'].includes(name)) {
      const match=new RegExp('<\\/'+name+'\\s*>','ig'); match.lastIndex=i;
      const closer=match.exec(s);
      if (!closer) throw Error('Unclosed text element.');
      let body=s.slice(i,closer.index);
      if (name==='script') {
        if (++scripts!==1 || tag!=='<script>') throw Error('Unrecognized script layout.');
        body=body.replace(new RegExp('^(\\r?\\n    const VERSION = ")('+version+')(";\\r?\\n)'),(_,p,v,q)=>p+save('script',v)+q);
      } else if (name==='style' && ++styles===1) {
        body=body.replace(/^(\s*:root \{)([^{}]*)(\})/,(_,start,vars,end)=>
          start+vars.replace(/^(\s*--([a-z-]+): )#[a-fA-F0-9]{6}(;[ \t]*)(?=\r?$)/gm,
            (all,left,key,right)=>colors.includes(key)?left+'\0'+right:all)+end);
      } else if (name==='title' && tag==='<title>') {
        body=body.replace(new RegExp('('+version+')$'),v=>save('title',v));
      }
      parts.push(body,closer[0]); i=match.lastIndex; continue;
    }
    if (['svg','math','template','iframe','noscript','xmp','plaintext','noembed','noframes','listing'].includes(name)) throw Error('Unsupported embedded content.');
    if (!voidTags.has(name)) stack.push({name,open:tag});
  }
  if (stack.length || ['header','badge','title','script','log'].some(k=>!versions[k] || versions[k]!==versions.script)) throw Error('Version markers or document structure do not agree.');
  return {signature:parts.join(''),version:versions.script};
}

export function classifyDirectories(baseline,candidate) {
  try {
    const a=files(baseline), b=files(candidate);
    const keys=[...new Set([...a.keys(),...b.keys()])];
    const changed=keys.filter(k=>a.get(k)?.hash!==b.get(k)?.hash || a.get(k)?.executable!==b.get(k)?.executable);
    if (changed.some(k=>!assets.includes(k))) return review('Release controls changed: separate administrator review required.',{controlChanged:true});
    if (assets.some(k=>a.get(k).executable!==b.get(k).executable)) return review('A public file mode changed.');
    if (changed.includes('index.html')) {
      const old=signature(a.get('index.html').data), next=signature(b.get('index.html').data);
      if (old.signature!==next.signature) return review('Application logic, structure, settings or unclassified markup changed.');
      const ov=old.version.slice(1).split('.').map(Number), nv=next.version.slice(1).split('.').map(Number);
      const d=nv.findIndex((v,i)=>v!==ov[i]);
      if (d>=0 && nv[d]<ov[d]) return review('Publication version would decrease.');
    }
    return {decision:'auto', reasons:[changed.length?'Only recognized presentational or documentation changes.':'No content change.'], changed};
  } catch (e) {
    return review(e.code?'Checkout unreadable.':e.message,{unclassified:true});
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  const result=args.length===2?classifyDirectories(...args):review('Usage: classify.mjs BASE_DIRECTORY CANDIDATE_DIRECTORY');
  console.log(JSON.stringify(result));
  process.exitCode=result.decision==='auto'?0:2;
}
