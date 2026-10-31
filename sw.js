const CACHE='okajb-prompteur-v1-7';
const CORE=['./','./index.html','./app.js','./manifest.webmanifest','./catalogue.json','./logo-okajb-prompteur.png','./icon-192.png','./icon-512.png','./apple-touch-icon.png','./favicon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(x=>x.startsWith('okajb-prompteur-')&&x!==CACHE).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||new URL(e.request.url).origin!==location.origin)return;const url=new URL(e.request.url);if(url.pathname.endsWith('.mp3')||url.pathname.endsWith('.wav')||url.pathname.endsWith('.m4a'))return;e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request)))});
