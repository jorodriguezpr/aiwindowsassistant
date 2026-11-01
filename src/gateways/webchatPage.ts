/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * The chat window page (1.6.0): the conversation (mirrored with Telegram) plus, when the
 * SysAiBrain avatar pack is installed, the SysAiBrain avatar that reads the answers aloud with
 * moving lips and listens hands-free.
 *
 * Everything on this page is AiWindowsAssistant's own code — voice (the browser's speech
 * synthesis, word events drive the lips), listening (the browser's speech recognition, paused
 * while speaking), spoken approvals ("approve" / "deny"), what is worth saying aloud. The only
 * SysAiBrain part is the avatar renderer itself, loaded from the binary pack as /sab/avatar.js
 * (it draws on #avatarCanvas and exposes window.SysAiAvatarClassic). Attribution: the footer
 * link to sysaibrain.com.
 */

export function chatPage(hasAvatar: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>AiWindowsAssistant</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:#f3f4f6;--me:#2563eb;--bot:#fff;--fg:#111;--muted:#6b7280;--stage:#0b1020}
@media (prefers-color-scheme:dark){:root{--bg:#111827;--bot:#1f2937;--fg:#f3f4f6;--muted:#9ca3af}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 "Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--fg);display:flex;flex-direction:column;height:100vh}
#stage{position:relative;height:24vh;min-height:130px;max-height:230px;background:var(--stage)}
#stage.size-m{height:32vh;max-height:320px}#stage.size-l{height:44vh;max-height:none}
#stage.hidden{display:none}
/* close to square and centred: the whole head shrinks with the box instead of being cropped */
#avatarCanvas{height:100%;width:auto;aspect-ratio:1.1;max-width:100%;margin:0 auto;display:block;touch-action:none;
 -webkit-mask-image:linear-gradient(to right,transparent,#000 18%,#000 82%,transparent);mask-image:linear-gradient(to right,transparent,#000 18%,#000 82%,transparent)}
#status{position:absolute;left:8px;bottom:6px;font-size:11px;color:#8ea3d8}
#state{position:absolute;right:10px;top:8px;font-size:12px;color:#cfe0ff;background:#0006;padding:2px 8px;border-radius:10px}
.bar{display:flex;gap:6px;padding:6px 10px;border-bottom:1px solid #8883;align-items:center;flex-wrap:wrap}
.bar button,.bar select{border:1px solid #8885;border-radius:8px;padding:4px 9px;background:var(--bot);color:var(--fg);cursor:pointer;font:inherit}
.bar button.on{background:#16a34a;color:#fff;border-color:#16a34a}
#feed{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.m{max-width:88%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}
.bot{background:var(--bot);align-self:flex-start;box-shadow:0 1px 2px #0002}.me{background:var(--me);color:#fff;align-self:flex-end}
.note{align-self:center;color:var(--muted);font-size:12px}
.b{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}.b button{border:0;border-radius:8px;padding:6px 10px;cursor:pointer;background:#e5e7eb}
.b button.ok{background:#16a34a;color:#fff}.b button.no{background:#dc2626;color:#fff}
form{display:flex;gap:6px;padding:10px;border-top:1px solid #8883}
textarea{flex:1;resize:none;height:42px;border-radius:10px;border:1px solid #8885;padding:10px;font:inherit;background:var(--bot);color:var(--fg)}
form button{border:0;border-radius:10px;padding:0 14px;cursor:pointer;background:var(--me);color:#fff;font-size:16px}
#mic.on{background:#dc2626}
footer{font-size:11px;color:var(--muted);text-align:center;padding:0 8px 6px}footer a{color:inherit}
</style></head><body>
<div id="stage" class="${hasAvatar ? '' : 'hidden'}"><canvas id="avatarCanvas"></canvas><div id="status"></div><div id="state"></div></div>
<div class="bar">
 <button id="talk" title="Hands-free: I listen, you talk, I answer aloud">🎙 Conversation</button>
 <button id="voiceBtn" class="on" title="Read answers aloud">🔊 Voice</button>
 ${hasAvatar ? '<button id="faceBtn" class="on" title="Show or hide the avatar">🧑 Avatar</button><button id="sizeBtn" title="Avatar size: small, medium, large">↕ S</button>' : ''}
 <select id="lang" title="Language I listen and speak in"><option value="auto">Auto</option><option value="es-ES">Español</option><option value="en-US">English</option></select>
</div>
<div id="feed"><div class="m note">Same conversation as Telegram. Talk with 🎙 or type — try "health check" or "open bluetooth settings".</div></div>
<form id="f"><button type="button" id="mic" title="Say one thing">🎤</button><textarea id="t" placeholder="Ask or tell me what to do…" autofocus></textarea><button>➤</button></form>
<footer>${hasAvatar ? 'Avatar and voice experience by <a href="https://sysaibrain.com" target="_blank" rel="noopener">SysAiBrain — sysaibrain.com</a>' : 'Avatar by <a href="https://sysaibrain.com" target="_blank" rel="noopener">SysAiBrain — sysaibrain.com</a> (not included in this build)'}</footer>
${hasAvatar ? '<script src="/sab/avatar.js"></script>' : ''}
<script>
const $=id=>document.getElementById(id),feed=$('feed'),t=$('t'),items={};
const avatar=()=>window.SysAiAvatarClassic;
const store={get(k,d){try{return localStorage.getItem(k)??d}catch{return d}},set(k,v){try{localStorage.setItem(k,v)}catch{}}};
let last=0,voiceOn=store.get('aiwa_voice','1')==='1',talking=false,speaking=false,pendingApproval=null,waiting=false;
$('lang').value=store.get('aiwa_lang','auto');$('lang').onchange=()=>store.set('aiwa_lang',$('lang').value);
function state(s){$('state').textContent=s;$('state').style.display=s?'':'none'}state('');
if(!voiceOn)$('voiceBtn').classList.remove('on');
$('voiceBtn').onclick=()=>{voiceOn=!voiceOn;store.set('aiwa_voice',voiceOn?'1':'0');$('voiceBtn').classList.toggle('on',voiceOn);if(!voiceOn)speechSynthesis.cancel()};
// avatar size: small (default) / medium / large — remembered; the canvas follows its box
const SIZES=['s','m','l'];let size=store.get('aiwa_avatar_size','s');
function applySize(){$('stage').classList.remove('size-m','size-l');if(size!=='s')$('stage').classList.add('size-'+size);
 if($('sizeBtn'))$('sizeBtn').textContent='↕ '+size.toUpperCase();window.dispatchEvent(new Event('resize'))}
if($('sizeBtn')){$('sizeBtn').onclick=()=>{size=SIZES[(SIZES.indexOf(size)+1)%3];store.set('aiwa_avatar_size',size);applySize()};applySize()}
if($('faceBtn'))$('faceBtn').onclick=()=>{const h=$('stage').classList.toggle('hidden');$('faceBtn').classList.toggle('on',!h);avatar()?.setActive?.(!h)};

// ── what the bot says: show it, and say the final answers aloud ──
const NOT_SPOKEN=/^(🤖 Claude Code|🧠|⚙️|⏳|🩺 Checking|What task would you like|Anything else to delegate|⏱)/;
function render(it){let el=it.mid&&items[it.mid];if(it.deleted){if(el){el.remove();el.dataset.gone='1'}return}
 if(!el){el=document.createElement('div');feed.appendChild(el);if(it.mid)items[it.mid]=el}
 el.className='m '+it.who;el.textContent=it.text;el.dataset.v=(+el.dataset.v||0)+1;
 if(it.buttons&&it.buttons.length){const b=document.createElement('div');b.className='b';
  for(const [label,data] of it.buttons){const x=document.createElement('button');x.textContent=label;
   x.className=data.startsWith('deny')?'no':'ok';x.onclick=()=>answer(data,b);b.appendChild(x)}
  el.appendChild(b);pendingApproval={buttons:it.buttons,box:b}}
 feed.scrollTop=feed.scrollHeight;
 if(it.who==='bot'&&!NOT_SPOKEN.test(it.text)){const v=el.dataset.v;
  // progress lines are edited or deleted within a moment: only speak what stays put
  setTimeout(()=>{if(el.dataset.gone||el.dataset.v!==v)return;
   if(it.buttons&&it.buttons.length)say('I need your approval. '+firstLine(it.text)+'. Say approve or deny.');
   else{waiting=false;say(it.text);avatar()?.setBaseExpression?.('neutral')}},1300)}}
function firstLine(s){return s.replace(/[*_\`]/g,'').split('\\n').map(x=>x.trim()).filter(x=>x&&!/^⚠️?\\s*Approval required$/i.test(x))[0]||''}
function answer(data,box){post('/answer',{data}).then(()=>{box&&box.remove();pendingApproval=null})}
function post(u,body){return fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})}
// one fetch at a time, so the same line can never be added twice
let busy=false,expired=false;
async function refresh(){if(busy||expired)return;busy=true;
 try{const r=await fetch('/feed?after='+last);if(r.status===403){expired=true;render({who:'note',text:'Session expired — press the hotkey again.'});return}
  for(const it of await r.json()){if(it.n<=last)continue;last=it.n;render(it)}}catch(e){}finally{busy=false}}
async function poll(){await refresh();if(!expired)setTimeout(poll,800)}
function send(s){s=s.trim();if(!s)return;
 // a pending approval can be answered by voice
 if(pendingApproval&&/^(approve|approved|yes|ok|okay|go ahead|aprueba|aprobar|apruebo|aprobado|sí|si|dale|adelante)\\b/i.test(s)){const a=pendingApproval.buttons.find(b=>b[1].startsWith('appr'));if(a){render({who:'me',text:s});answer(a[1],pendingApproval.box);return}}
 if(pendingApproval&&/^(deny|denied|no|cancel|stop|niega|negar|deniega|cancela|no lo hagas)\\b/i.test(s)){const d=pendingApproval.buttons.find(b=>b[1].startsWith('deny'));if(d){render({who:'me',text:s});answer(d[1],pendingApproval.box);return}}
 // not shown here directly: the server's copy (same conversation as Telegram) is the one line shown
 waiting=true;avatar()?.setBaseExpression?.('thinking');post('/send',{text:s}).then(refresh)}
$('f').onsubmit=e=>{e.preventDefault();const s=t.value;t.value='';send(s)};
t.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('f').requestSubmit()}};

// ── voice: the browser's speech synthesis, words drive the avatar's lips ──
function langOf(text){const pick=$('lang').value;if(pick!=='auto')return pick;
 return /[ñáéíóú¿¡]|\\b(el|la|los|las|que|de|para|una|está|tu|tus|con|por)\\b/i.test(text)?'es-ES':'en-US'}
function voiceFor(lang){const vs=speechSynthesis.getVoices().filter(v=>v.lang.toLowerCase().startsWith(lang.slice(0,2)));
 return vs.find(v=>/natural|online/i.test(v.name)&&v.lang===lang)||vs.find(v=>/natural|online/i.test(v.name))||vs.find(v=>v.lang===lang)||vs[0]}
function speakable(text){return text.replace(/\`\`\`[\\s\\S]*?\`\`\`/g,' (code on screen) ').replace(/https?:\\/\\/\\S+/g,' (link on screen) ')
 .replace(/[*_#>\`|]/g,' ').replace(/[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/gu,' ').replace(/\\s+/g,' ').trim()}
let levelTimer=null;
function say(text){if(!voiceOn)return;let s=speakable(text);if(!s)return;
 if(s.length>450){const cut=s.slice(0,450);s=cut.slice(0,Math.max(cut.lastIndexOf('. '),200)+1)+' The rest is on screen.'}
 const u=new SpeechSynthesisUtterance(s),lang=langOf(s);u.lang=lang;const v=voiceFor(lang);if(v)u.voice=v;
 let words=0;
 u.onstart=()=>{speaking=true;pauseListening();avatar()?.setSpeaking?.(true);state('🔊 speaking');
  // voices without word events: keep the mouth moving from the text itself
  levelTimer=setInterval(()=>{if(!words)avatar()?.setLevel?.(0.25+Math.random()*0.55)},120)};
 u.onboundary=e=>{if(e.name&&e.name!=='word')return;words++;const w=s.substr(e.charIndex,(e.charLength||(s.slice(e.charIndex).search(/\\s|$/))));avatar()?.speakWord?.(w,0.28)};
 u.onend=u.onerror=()=>{clearInterval(levelTimer);speaking=false;avatar()?.setSpeaking?.(false);avatar()?.setLevel?.(0);state(talking?'🎙 listening':'');resumeListening()};
 speechSynthesis.speak(u)}
speechSynthesis.onvoiceschanged=()=>{};

// ── listening: the browser's speech recognition; hands-free in conversation mode ──
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;let rec=null,recOn=false;
function startRec(single){if(!SR||recOn||speaking)return;rec=new SR();rec.lang=$('lang').value==='auto'?(navigator.language||'en-US'):$('lang').value;
 rec.interimResults=true;rec.continuous=false;recOn=true;$('mic').classList.add('on');if(!single)state('🎙 listening');avatar()?.setBaseExpression?.('attentive');
 rec.onresult=e=>{const r=[...e.results];t.value=r.map(x=>x[0].transcript).join('');if(r[r.length-1].isFinal){const s=t.value;t.value='';send(s)}};
 rec.onerror=e=>{if(e.error==='not-allowed'){talking=false;$('talk').classList.remove('on');render({who:'note',text:'Microphone blocked — allow it in the browser to talk.'})}};
 rec.onend=()=>{recOn=false;$('mic').classList.remove('on');if(talking&&!speaking)setTimeout(()=>startRec(false),250);else if(!talking)state('')};
 try{rec.start()}catch{recOn=false}}
function pauseListening(){if(rec&&recOn){try{rec.abort()}catch{}}}
function resumeListening(){if(talking&&!recOn)setTimeout(()=>startRec(false),400)}
if(!SR){$('mic').style.display='none';$('talk').style.display='none'}
$('mic').onclick=()=>{if(recOn){pauseListening()}else startRec(true)};
$('talk').onclick=()=>{talking=!talking;$('talk').classList.toggle('on',talking);
 if(talking){speechSynthesis.cancel();startRec(false);say($('lang').value.startsWith('es')||(navigator.language||'').startsWith('es')?'Te escucho.':'I am listening.')}else{pauseListening();state('')}};
poll();
</script></body></html>`;
}
