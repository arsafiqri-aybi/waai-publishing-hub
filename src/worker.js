addEventListener('fetch', event => event.respondWith(handle(event.request)));

const MAX_FILE_BYTES = 25 * 1024 * 1024;

async function handle(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'GET' && path === '/') {
    return htmlResponse(DASHBOARD_HTML);
  }
  if (request.method === 'GET' && path === '/api/health') {
    return json({ ok: true, service: 'waai-publishing-hub', version: '1.1.0' });
  }
  if (request.method === 'GET' && path === '/api/posts') {
    return listPosts();
  }
  if (request.method === 'POST' && path === '/api/admin-check') {
    if (!(await isAdmin(request))) return json({ ok: false }, 401);
    return json({ ok: true });
  }
  if (request.method === 'POST' && path === '/api/upload') {
    if (!(await isAdmin(request))) return json({ error: 'Unauthorized' }, 401);
    return uploadPost(request);
  }
  if (request.method === 'POST' && path === '/api/media') {
    if (!(await isAdmin(request))) return json({ error: 'Unauthorized' }, 401);
    return uploadMediaRaw(request);
  }
  if (request.method === 'POST' && path === '/api/posts') {
    if (!(await isAdmin(request))) return json({ error: 'Unauthorized' }, 401);
    return createPostRecord(request);
  }
  const metricsMatch = path.match(/^\/api\/posts\/([^/]+)\/metrics$/);
  if (request.method === 'POST' && metricsMatch) {
    if (!(await isAdmin(request))) return json({ error: 'Unauthorized' }, 401);
    return updateMetrics(request, metricsMatch[1]);
  }
  const postMatch = path.match(/^\/api\/posts\/([^/]+)$/);
  if (request.method === 'PATCH' && postMatch) {
    if (!(await isAdmin(request))) return json({ error: 'Unauthorized' }, 401);
    return updatePost(request, postMatch[1]);
  }
  const mediaMatch = path.match(/^\/media\/([a-zA-Z0-9-]+)\.mp4$/);
  if ((request.method === 'GET' || request.method === 'HEAD') && mediaMatch) {
    return serveMedia(request, mediaMatch[1]);
  }
  return new Response('Not found', { status: 404 });
}

const ADMIN_KEY_HASH = '87bb636ce3ba83e21a03bcfaa91403b630566f165b1ac96d9cc926f3aadead83';
async function isAdmin(request) {
  const header = request.headers.get('x-admin-key') || '';
  const auth = request.headers.get('authorization') || '';
  const candidate = header || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
  if (!candidate) return false;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(candidate));
  const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === ADMIN_KEY_HASH;
}

async function uploadPost(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Invalid multipart form' }, 400);
  }

  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') {
    return json({ error: 'MP4 file is required' }, 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return json({ error: 'File exceeds 25 MiB limit' }, 413);
  }
  if (file.type && file.type !== 'video/mp4') {
    return json({ error: 'Only video/mp4 is accepted' }, 415);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const bytes = await file.arrayBuffer();
  const origin = new URL(request.url).origin;
  const mediaUrl = origin + '/media/' + id + '.mp4';

  await WAAI_DATA.put('media:' + id, bytes);
  await WAAI_DATA.put('media-meta:' + id, JSON.stringify({
    content_type: 'video/mp4',
    filename: clean(file.name || 'video.mp4'),
    size_bytes: file.size,
    created_at: createdAt
  }));

  const post = {
    id,
    title: str(form.get('title')) || 'Untitled Reel',
    caption: str(form.get('caption')),
    platform: str(form.get('platform')) || 'Instagram',
    status: str(form.get('status')) || 'ready',
    created_at: createdAt,
    published_at: str(form.get('published_at')),
    permalink: str(form.get('permalink')),
    media_url: mediaUrl,
    filename: clean(file.name || 'video.mp4'),
    size_bytes: file.size,
    metrics: { views: 0, reach: 0, likes: 0, saves: 0, shares: 0, comments: 0 }
  };

  await WAAI_DATA.put('post:' + createdAt + ':' + id, JSON.stringify(post));
  await WAAI_DATA.put('post-id:' + id, 'post:' + createdAt + ':' + id);
  return json({ ok: true, post }, 201);
}

async function uploadMediaRaw(request) {
  const type = request.headers.get('content-type') || '';
  if (type && !type.toLowerCase().startsWith('video/mp4') && type !== 'application/octet-stream') return json({ error: 'Only MP4 is accepted' }, 415);
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared && declared > MAX_FILE_BYTES) return json({ error: 'File exceeds 25 MiB limit' }, 413);
  let bytes;
  try { bytes = await request.arrayBuffer(); } catch { return json({ error: 'Could not read upload body' }, 400); }
  if (!bytes.byteLength) return json({ error: 'Empty upload' }, 400);
  if (bytes.byteLength > MAX_FILE_BYTES) return json({ error: 'File exceeds 25 MiB limit' }, 413);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const filename = clean(decodeURIComponent(request.headers.get('x-filename') || 'video.mp4'));
  await WAAI_DATA.put('media:' + id, bytes);
  await WAAI_DATA.put('media-meta:' + id, JSON.stringify({ content_type:'video/mp4', filename, size_bytes:bytes.byteLength, created_at:createdAt }));
  const origin = new URL(request.url).origin;
  return json({ ok:true, media:{ id, media_url:origin + '/media/' + id + '.mp4', filename, size_bytes:bytes.byteLength, created_at:createdAt } }, 201);
}

async function createPostRecord(request) {
  let body;
  try { body = await request.json(); } catch { return json({ error:'Invalid JSON' }, 400); }
  const mediaId = str(body.media_id);
  if (!mediaId) return json({ error:'media_id is required' }, 400);
  const metaRaw = await WAAI_DATA.get('media-meta:' + mediaId);
  if (!metaRaw) return json({ error:'Uploaded media not found' }, 404);
  const meta = JSON.parse(metaRaw);
  const createdAt = new Date().toISOString();
  const origin = new URL(request.url).origin;
  const post = {
    id:mediaId, title:str(body.title)||'Untitled Reel', caption:str(body.caption),
    platform:str(body.platform)||'Instagram', status:str(body.status)||'ready',
    created_at:createdAt, published_at:str(body.published_at), permalink:str(body.permalink),
    media_url:origin + '/media/' + mediaId + '.mp4', filename:meta.filename||'video.mp4',
    size_bytes:meta.size_bytes||0,
    metrics:{ views:0, reach:0, likes:0, saves:0, shares:0, comments:0 }
  };
  const postKey='post:' + createdAt + ':' + mediaId;
  await WAAI_DATA.put(postKey, JSON.stringify(post));
  await WAAI_DATA.put('post-id:' + mediaId, postKey);
  return json({ ok:true, post }, 201);
}

async function listPosts() {
  const listed = await WAAI_DATA.list({ prefix: 'post:' });
  const posts = [];
  for (const key of listed.keys) {
    const raw = await WAAI_DATA.get(key.name);
    if (!raw) continue;
    try { posts.push(JSON.parse(raw)); } catch {}
  }
  posts.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return json({ posts, count: posts.length });
}

async function getPost(id) {
  const key = await WAAI_DATA.get('post-id:' + id);
  if (!key) return null;
  const raw = await WAAI_DATA.get(key);
  if (!raw) return null;
  return { key, post: JSON.parse(raw) };
}

async function updateMetrics(request, id) {
  const found = await getPost(id);
  if (!found) return json({ error: 'Post not found' }, 404);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const current = found.post.metrics || {};
  found.post.metrics = {
    views: num(body.views, current.views),
    reach: num(body.reach, current.reach),
    likes: num(body.likes, current.likes),
    saves: num(body.saves, current.saves),
    shares: num(body.shares, current.shares),
    comments: num(body.comments, current.comments)
  };
  found.post.metrics_updated_at = new Date().toISOString();
  await WAAI_DATA.put(found.key, JSON.stringify(found.post));
  return json({ ok: true, post: found.post });
}

async function updatePost(request, id) {
  const found = await getPost(id);
  if (!found) return json({ error: 'Post not found' }, 404);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const allowed = ['title', 'caption', 'status', 'published_at', 'permalink', 'platform'];
  for (const field of allowed) {
    if (field in body) found.post[field] = str(body[field]);
  }
  found.post.updated_at = new Date().toISOString();
  await WAAI_DATA.put(found.key, JSON.stringify(found.post));
  return json({ ok: true, post: found.post });
}

async function serveMedia(request, id) {
  const buffer = await WAAI_DATA.get('media:' + id, 'arrayBuffer');
  if (!buffer) return new Response('Not found', { status: 404 });
  const total = buffer.byteLength;
  const baseHeaders = {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=86400',
    'access-control-allow-origin': '*'
  };
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { ...baseHeaders, 'content-length': String(total) } });
  }
  const range = request.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : total - 1;
      if (!match[1] && match[2]) {
        const suffix = Number(match[2]);
        start = Math.max(0, total - suffix);
        end = total - 1;
      }
      if (start <= end && start < total) {
        end = Math.min(end, total - 1);
        const slice = buffer.slice(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            ...baseHeaders,
            'content-range': 'bytes ' + start + '-' + end + '/' + total,
            'content-length': String(slice.byteLength)
          }
        });
      }
    }
    return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + total } });
  }
  return new Response(buffer, { status: 200, headers: { ...baseHeaders, 'content-length': String(total) } });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
function htmlResponse(value) {
  return new Response(value, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
}
function str(v) { return v == null ? '' : String(v).trim(); }
function clean(v) { return str(v).replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 120); }
function num(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : (fallback || 0); }

const DASHBOARD_HTML = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>WAAI Publishing Hub</title>
<style>
:root{--bg:#f4f0e9;--ink:#171717;--muted:#726c65;--card:#fffdf9;--line:#ddd5ca;--rose:#b77878;--rose2:#eadada;--ok:#2f6e4f;--shadow:0 16px 50px rgba(36,25,16,.08)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{width:min(1180px,calc(100% - 32px));margin:auto;padding:28px 0 70px}.top{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;padding:18px 0 34px;border-bottom:1px solid var(--line)}.eyebrow{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}h1{font-family:Georgia,"Times New Roman",serif;font-weight:500;font-size:clamp(36px,6vw,68px);line-height:.95;margin:8px 0 0;letter-spacing:-.04em}.tagline{max-width:350px;text-align:right;color:var(--muted);line-height:1.5;font-size:14px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:22px 0}.stat,.panel,.post{background:rgba(255,253,249,.78);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow)}.stat{padding:20px}.stat b{display:block;font-family:Georgia,serif;font-size:34px;font-weight:500}.stat span{font-size:12px;color:var(--muted)}.layout{display:grid;grid-template-columns:360px 1fr;gap:18px;align-items:start}.panel{padding:20px;position:sticky;top:18px}.panel h2,.library h2{font-size:16px;margin:0 0 6px}.sub{font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:18px}label{display:block;font-size:12px;color:var(--muted);margin:12px 0 6px}input,textarea,select{width:100%;border:1px solid var(--line);background:#fffefa;border-radius:13px;padding:11px 12px;color:var(--ink);font:inherit;outline:none}textarea{min-height:115px;resize:vertical}input:focus,textarea:focus,select:focus{border-color:#bfa6a0;box-shadow:0 0 0 3px rgba(183,120,120,.12)}.filebox{padding:14px;border:1px dashed #c8bbb0;border-radius:14px;background:#faf6f0}.btn{border:0;border-radius:999px;padding:11px 16px;background:var(--ink);color:white;font-weight:650;cursor:pointer}.btn.secondary{background:#fffefa;color:var(--ink);border:1px solid var(--line)}.btn:disabled{opacity:.5;cursor:not-allowed}.row{display:flex;gap:8px;align-items:center}.row>*{flex:1}.statusline{font-size:12px;min-height:18px;margin-top:10px;color:var(--muted)}.uploadbox{margin-top:12px;padding:13px;border:1px solid var(--line);border-radius:14px;background:#faf7f2;display:none}.uploadbox.active{display:block}.progress{height:8px;border-radius:999px;background:#e9e0d6;overflow:hidden;margin:8px 0}.progress>i{display:block;height:100%;width:0;background:var(--ink);transition:width .15s linear}.uploadmsg{font-size:12px;line-height:1.45}.uploadmsg.ok{color:var(--ok)}.uploadmsg.err{color:#9b3d3d;font-weight:600}.library{min-width:0}.libhead{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:2px 0 14px}.search{max-width:290px}.posts{display:grid;gap:12px}.post{padding:18px;display:grid;grid-template-columns:1fr auto;gap:18px}.post h3{font-family:Georgia,serif;font-size:23px;font-weight:500;margin:0 0 7px}.meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:12px}.pill{padding:4px 8px;border-radius:999px;background:var(--rose2);color:#744e4e;font-size:11px}.caption{white-space:pre-wrap;color:#4d4944;line-height:1.55;font-size:13px;margin-top:13px;max-height:86px;overflow:hidden}.metrics{display:grid;grid-template-columns:repeat(3,minmax(54px,1fr));gap:6px;min-width:210px}.metric{padding:9px;border-radius:12px;background:#f7f2eb;border:1px solid #ebe2d8}.metric b{display:block;font-size:15px}.metric span{font-size:10px;color:var(--muted)}.actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:13px}.tiny{font-size:11px;padding:7px 10px}.empty{padding:45px 18px;text-align:center;border:1px dashed var(--line);border-radius:20px;color:var(--muted)}.locknote{font-size:11px;color:var(--muted);margin-top:8px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--ok);margin-right:6px}.footer{margin-top:38px;padding-top:18px;border-top:1px solid var(--line);display:flex;justify-content:space-between;color:var(--muted);font-size:11px}@media(max-width:820px){.top{align-items:flex-start;flex-direction:column}.tagline{text-align:left}.layout{grid-template-columns:1fr}.panel{position:static}.stats{grid-template-columns:1fr}.post{grid-template-columns:1fr}.metrics{min-width:0}.libhead{align-items:flex-start;flex-direction:column}.search{max-width:none;width:100%}}
</style>
</head>
<body>
<div class="shell">
  <header class="top"><div><div class="eyebrow">WAAI / Content Operations</div><h1>Publishing Hub</h1></div><div class="tagline">Satu tempat sederhana untuk menyiapkan media, mendapatkan HTTPS publik, dan menyimpan jejak konten WAAI.</div></header>
  <section class="stats"><div class="stat"><b id="totalPosts">0</b><span>Total content records</span></div><div class="stat"><b id="publishedPosts">0</b><span>Published</span></div><div class="stat"><b id="totalViews">0</b><span>Tracked views</span></div></section>
  <main class="layout">
    <aside class="panel">
      <h2>New content</h2><div class="sub">Upload MP4 ≤25 MiB. File akan mendapatkan URL HTTPS publik dari Cloudflare.</div>
      <form id="uploadForm">
        <label>Admin key</label><input id="adminKey" type="password" autocomplete="off" placeholder="••••••••••••" />
        <label>Title</label><input name="title" required placeholder="Temani aku sebentar" />
        <label>Caption</label><textarea name="caption" placeholder="Caption Instagram..."></textarea>
        <div class="row"><div><label>Status</label><select name="status"><option value="ready">Ready</option><option value="published">Published</option><option value="draft">Draft</option></select></div><div><label>Platform</label><select name="platform"><option>Instagram</option></select></div></div>
        <label>Permalink (optional)</label><input name="permalink" type="url" placeholder="https://instagram.com/reel/..." />
        <label>Published at (optional)</label><input name="published_at" type="datetime-local" />
        <label>MP4</label><div class="filebox"><input name="file" type="file" accept="video/mp4" required /></div>
        <div style="height:14px"></div><button class="btn" id="uploadBtn" type="submit">Upload to Cloudflare</button>
        <div id="uploadStatus" class="statusline"></div>
        <div id="uploadBox" class="uploadbox"><div id="uploadMsg" class="uploadmsg">Menyiapkan upload…</div><div class="progress"><i id="uploadBar"></i></div><div id="uploadPct" class="uploadmsg">0%</div></div>
        <div class="locknote">Admin key disimpan hanya di browser ini (localStorage), bukan di halaman publik.</div>
      </form>
    </aside>
    <section class="library"><div class="libhead"><div><h2>Content library</h2><div class="sub" style="margin:4px 0 0">Riwayat media, posting, dan metrics yang kita simpan.</div></div><input class="search" id="search" placeholder="Search title / caption..." /></div><div id="posts" class="posts"></div></section>
  </main>
  <footer class="footer"><span><span class="dot"></span>Cloudflare Worker online</span><span>WAAI Publishing Hub · v1.1</span></footer>
</div>
<script>
const $ = s => document.querySelector(s); let allPosts = [];
const fmt = n => new Intl.NumberFormat('id-ID').format(Number(n||0));
const esc = s => String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const dateFmt = s => s ? new Date(s).toLocaleString('id-ID',{dateStyle:'medium',timeStyle:'short'}) : '—';
$('#adminKey').value = localStorage.getItem('waai_admin_key') || '';
$('#adminKey').addEventListener('change',()=>localStorage.setItem('waai_admin_key',$('#adminKey').value));
async function loadPosts(){ const r=await fetch('/api/posts'); const d=await r.json(); allPosts=d.posts||[]; render(allPosts); }
function render(posts){
  $('#totalPosts').textContent=fmt(posts.length); $('#publishedPosts').textContent=fmt(posts.filter(p=>p.status==='published').length); $('#totalViews').textContent=fmt(posts.reduce((a,p)=>a+Number(p.metrics?.views||0),0));
  if(!posts.length){ $('#posts').innerHTML='<div class="empty">Belum ada content record.</div>'; return; }
  $('#posts').innerHTML=posts.map(p=>'<article class="post"><div><div class="meta"><span class="pill">'+esc(p.status||'ready')+'</span><span>'+esc(p.platform||'Instagram')+'</span><span>'+dateFmt(p.published_at||p.created_at)+'</span></div><h3>'+esc(p.title)+'</h3><div class="caption">'+esc(p.caption)+'</div><div class="actions"><a class="btn secondary tiny" href="'+esc(p.media_url)+'" target="_blank">Open media</a><button class="btn secondary tiny" onclick="copyText(\''+esc(p.media_url)+'\')">Copy HTTPS</button>'+(p.permalink?'<a class="btn secondary tiny" href="'+esc(p.permalink)+'" target="_blank">Instagram</a>':'')+'</div></div><div class="metrics">'+metric('Views',p.metrics?.views)+metric('Reach',p.metrics?.reach)+metric('Likes',p.metrics?.likes)+metric('Saves',p.metrics?.saves)+metric('Shares',p.metrics?.shares)+metric('Comments',p.metrics?.comments)+'</div></article>').join('');
}
function metric(label,n){return '<div class="metric"><b>'+fmt(n)+'</b><span>'+label+'</span></div>'}
window.copyText=async t=>{await navigator.clipboard.writeText(t)};
$('#search').addEventListener('input',e=>{const q=e.target.value.toLowerCase();render(allPosts.filter(p=>(p.title+' '+p.caption).toLowerCase().includes(q)))});
function xhrUpload(file,key){return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST','/api/media');xhr.setRequestHeader('x-admin-key',key);xhr.setRequestHeader('x-filename',encodeURIComponent(file.name||'video.mp4'));xhr.setRequestHeader('content-type','video/mp4');xhr.upload.onprogress=e=>{if(!e.lengthComputable)return;const p=Math.max(1,Math.min(99,Math.round((e.loaded/e.total)*100)));$('#uploadBar').style.width=p+'%';$('#uploadPct').textContent=p+'% · '+(e.loaded/1048576).toFixed(1)+' / '+(e.total/1048576).toFixed(1)+' MB';$('#uploadMsg').textContent='Mengirim MP4 ke Cloudflare…';};xhr.onload=()=>{let d={};try{d=JSON.parse(xhr.responseText||'{}')}catch{}if(xhr.status>=200&&xhr.status<300)resolve(d);else reject(new Error(d.error||('Upload gagal (HTTP '+xhr.status+')')))};xhr.onerror=()=>reject(new Error('Koneksi upload terputus.'));xhr.send(file);});}
$('#uploadForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,btn=$('#uploadBtn'),status=$('#uploadStatus'),box=$('#uploadBox'),msg=$('#uploadMsg'),bar=$('#uploadBar'),pct=$('#uploadPct');const key=$('#adminKey').value.trim();const file=form.querySelector('input[name="file"]').files[0];if(!key){status.textContent='Admin key diperlukan.';return}if(!file){status.textContent='Pilih file MP4 dulu.';return}if(file.size>25*1024*1024){status.textContent='File terlalu besar. Maksimal 25 MiB.';return}localStorage.setItem('waai_admin_key',key);btn.disabled=true;box.classList.add('active');msg.className='uploadmsg';msg.textContent='Memeriksa akses…';bar.style.width='0%';pct.textContent='0%';status.textContent='';try{const auth=await fetch('/api/admin-check',{method:'POST',headers:{'x-admin-key':key}});if(!auth.ok)throw new Error('Admin key salah.');const uploaded=await xhrUpload(file,key);bar.style.width='100%';pct.textContent='100% · upload selesai';msg.textContent='MP4 tersimpan. Menyimpan metadata…';const fields=new FormData(form);const published=fields.get('published_at');const payload={media_id:uploaded.media.id,title:fields.get('title')||'Untitled Reel',caption:fields.get('caption')||'',platform:fields.get('platform')||'Instagram',status:fields.get('status')||'ready',permalink:fields.get('permalink')||'',published_at:published?new Date(published).toISOString():''};const meta=await fetch('/api/posts',{method:'POST',headers:{'x-admin-key':key,'content-type':'application/json'},body:JSON.stringify(payload)});const d=await meta.json();if(!meta.ok)throw new Error(d.error||'Metadata gagal disimpan.');msg.className='uploadmsg ok';msg.innerHTML='✓ Upload berhasil.<br><strong>'+d.post.media_url+'</strong>';status.textContent='Cloudflare ready · '+(file.size/1048576).toFixed(1)+' MB';form.reset();$('#adminKey').value=key;await loadPosts( --- TRUNCATED --- 23,697 chars