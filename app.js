"use strict";
const $ = id=>document.getElementById(id);
const escapeHTML=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>crypto.randomUUID?.()||String(Date.now())+'-'+Math.random();
const fmt=s=>{s=Math.max(0,Math.floor(Number(s)||0));return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')};
const writeStatus=(s,id='studioStatus')=>$(id).textContent=s;
const DB='okajb-prompter-v1', STORE='songs';
let db,current=null,editing=null,mode='instrumental',stream=null,facing='user',recording=false,counting=false;
let recorder=null,recChunks=[],recCtx=null,recDest=null,recSource=null,recMic=null,recStream=null;
let objectAudioURL=null,videoURL=null,raf=null,clockStarted=0,timeBefore=0,playing=false,skipRecordStop=false;
let uploadedRemoved={instrumental:false,full:false};
let cameraZoom=1,zoomPointers=new Map(),zoomPinch=null,zoomCanvas=null,zoomCanvasStream=null,zoomDrawFrame=0,zoomCaptureActive=false,zoomRecordingSupported=true;
let videoFormat='portrait',recordedFormat='portrait',pendingVideoBlob=null,pendingVideoURL=null;
function updateCameraFrame(){
 const stage=$('stage'),frame=$('cameraFrame');if(!stage||!frame||!stage.clientWidth||!stage.clientHeight)return;
 const ratio=videoFormat==='landscape'?16/9:9/16,w=Math.min(stage.clientWidth,stage.clientHeight*ratio);
 frame.style.width=Math.round(w)+'px';frame.style.height=Math.round(w/ratio)+'px';
}
function selectVideoFormat(format){
 if(recording||counting)return;
 videoFormat=format==='landscape'?'landscape':'portrait';
 $('formatPortrait').classList.toggle('active',videoFormat==='portrait');
 $('formatLandscape').classList.toggle('active',videoFormat==='landscape');
 $('formatToggle').textContent=videoFormat==='portrait'?'📱 9:16':'▭ 16:9';
 $('formatToggle').setAttribute('aria-label','Format '+(videoFormat==='portrait'?'vertical 9 sur 16':'paysage 16 sur 9')+'. Toucher pour changer.');
 updateCameraFrame();
}
window.addEventListener('resize',updateCameraFrame);
if(typeof ResizeObserver!=='undefined')new ResizeObserver(updateCameraFrame).observe($('stage'));
function setCameraZoom(value){
 if(recording&&!zoomCaptureActive)return;
 cameraZoom=Math.min(3,Math.max(1,Number(value)||1));
 $('stage').style.setProperty('--camera-zoom',String(cameraZoom));
 $('zoomReset').textContent=cameraZoom.toFixed(1).replace('.',',')+'×';
 $('zoomReset').setAttribute('aria-label','Zoom caméra '+cameraZoom.toFixed(1)+' fois. Appuyer pour revenir à 1 fois');
}
function pinchDistance(){
 const a=Array.from(zoomPointers.values());
 return a.length<2?0:Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y);
}
function startZoomCapture(){
 const video=$('cameraPreview');
 if(typeof HTMLCanvasElement==='undefined'||!HTMLCanvasElement.prototype.captureStream||video.readyState<2||!video.videoWidth||!video.videoHeight)return null;
 const canvas=document.createElement('canvas');
 if(videoFormat==='portrait'){canvas.width=720;canvas.height=1280}
 else{canvas.width=1280;canvas.height=720}
 const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)return null;
 zoomCanvas=canvas;
 const draw=()=>{
  if(!zoomCanvas)return;
  if(video.readyState>=2){
   const w=video.videoWidth,h=video.videoHeight,r=canvas.width/canvas.height;
   let cropW=Math.min(w,h*r),cropH=cropW/r;
   const zoom=Math.max(1,cameraZoom);cropW/=zoom;cropH/=zoom;
   try{ctx.drawImage(video,(w-cropW)/2,(h-cropH)/2,cropW,cropH,0,0,canvas.width,canvas.height)}catch{}
  }
  zoomDrawFrame=requestAnimationFrame(draw);
 };
 draw();
 try{zoomCanvasStream=canvas.captureStream(24);const track=zoomCanvasStream.getVideoTracks()[0];
  if(!track){stopZoomCapture();return null}
  zoomCaptureActive=true;return track;
 }catch(e){stopZoomCapture();return null}
}
function stopZoomCapture(){
 if(zoomDrawFrame)cancelAnimationFrame(zoomDrawFrame);
 zoomDrawFrame=0;
 zoomCanvasStream?.getTracks().forEach(t=>t.stop());
 zoomCanvasStream=null;zoomCanvas=null;zoomCaptureActive=false;
}
const hasAudio=(s,m)=>!!(m==='instrumental'?(s?.instrumentalFile||s?.instrumentalUrl):(s?.fullFile||s?.fullUrl));
const trackSource=(s,m)=>m==='instrumental'?(s.instrumentalFile||s.instrumentalUrl):(s.fullFile||s.fullUrl);
const timingKeys=(m)=>m==='instrumental'?['offsetInstrumental','durationInstrumental']:['offsetFull','durationFull'];
function tx(mode='readonly'){return db.transaction(STORE,mode).objectStore(STORE)}
function req(r){return new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
const getAll=()=>req(tx().getAll()), get=id=>req(tx().get(id)), put=s=>req(tx('readwrite').put(s)), del=id=>req(tx('readwrite').delete(id)), clearAll=()=>req(tx('readwrite').clear());
async function openDB(){return new Promise((res,rej)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore(STORE,{keyPath:'id'});r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function loadCatalog(){
 const response=await fetch('./catalogue.json',{cache:'no-store'});if(!response.ok)throw Error('Catalogue indisponible');
 const cat=await response.json();for(const item of cat.songs){const old=await get(item.id);
 if(!old){await put({...item,updated:0});continue}
 // Never overwrite user edits or files. Allow fresh catalogue lyrics only when still empty.
 if((old.updated||0)===0){
   let changed=false;
   for(const key of ['lyrics','instrumentalUrl','fullUrl','durationInstrumental','durationFull']){
     if(item[key]!==undefined && (key==='lyrics' ? !old[key] : key.endsWith('Url') ? !old[key] : old[key]===60)){
       old[key]=item[key];changed=true;
     }
   }
   if(changed) await put(old);
 }
 }
}
function show(which){setImmersive(false);for(const key of ['library','editor','studio'])$(key).classList.toggle('hidden',key!==which);$('navLibrary').classList.toggle('active',which!=='studio');$('navStudio').classList.toggle('active',which==='studio');window.scrollTo(0,0)}
async function renderSongs(){const all=await getAll(),search=$('search').value.toLocaleLowerCase('fr').trim();all.sort((a,b)=>(a.updated||0)===(b.updated||0)?a.title.localeCompare(b.title,'fr'):(b.updated||0)-(a.updated||0));
 const list=all.filter(s=>s.title.toLocaleLowerCase('fr').includes(search));$('songCount').textContent=all.length+' chansons · '+all.filter(s=>s.lyrics&&hasAudio(s,'instrumental')&&hasAudio(s,'full')).length+' entièrement prêtes';
 $('songs').innerHTML=list.map(s=>`<div class="song"><div class="songinfo"><div class="songname">${escapeHTML(s.title)}</div><div class="songmeta">${s.lyrics?'✓ Paroles':'○ Paroles à ajouter'} · ${hasAudio(s,'instrumental')?'✓ Instru':'○ Instru'} · ${hasAudio(s,'full')?'✓ Voix':'○ Voix'}</div></div><div class="songbtns"><button class="primary" data-action="open" data-id="${escapeHTML(s.id)}">▶ Ouvrir</button><button data-action="edit" data-id="${escapeHTML(s.id)}">✎</button><button data-action="delete" data-id="${escapeHTML(s.id)}">✕</button></div></div>`).join('')||'<p class="muted">Aucun titre trouvé.</p>';
}
async function editSong(song){editing=song?.id||null;uploadedRemoved={instrumental:false,full:false};$('formHeading').textContent=song?'Modifier le titre':'Ajouter un titre';$('titleInput').value=song?.title||'';$('lyricsInput').value=song?.lyrics||'';
 $('offsetInstru').value=song?.offsetInstrumental??0;$('durationInstru').value=song?.durationInstrumental??60;
 $('offsetVoix').value=song?.offsetFull??0;$('durationVoix').value=song?.durationFull??60;
 $('uploadInstru').value='';$('uploadVoix').value='';$('lyricsFile').value='';$('instruInfo').textContent=trackLabel(song,'instrumental');$('voixInfo').textContent=trackLabel(song,'full');writeStatus('','editStatus');show('editor')}
function trackLabel(s,m){if(!s)return'Aucun fichier';const f=m==='instrumental'?s.instrumentalFile:s.fullFile;return f?'✓ '+(s[m+'Name']||f.name||'Audio enregistré'):hasAudio(s,m)?'✓ Audio associé':'Aucun fichier'}
async function saveSong(){const title=$('titleInput').value.trim();if(!title){writeStatus('Le titre est obligatoire.','editStatus');return}
 const s=editing?await get(editing):{id:uid(),updated:0};const fi=$('uploadInstru').files[0],fv=$('uploadVoix').files[0];
 if([fi,fv].some(f=>f&&f.size>170*1024*1024)){writeStatus('Fichier audio trop volumineux (limite conseillée : 170 Mo).','editStatus');return}
 s.title=title;s.lyrics=$('lyricsInput').value.trim();s.offsetInstrumental=Math.max(0,Number($('offsetInstru').value)||0);s.offsetFull=Math.max(0,Number($('offsetVoix').value)||0);
 s.durationInstrumental=Math.max(1,Number($('durationInstru').value)||60);s.durationFull=Math.max(1,Number($('durationVoix').value)||60);
 if(uploadedRemoved.instrumental){s.instrumentalFile=null;s.instrumentalUrl=''}if(uploadedRemoved.full){s.fullFile=null;s.fullUrl=''}
 if(fi){s.instrumentalFile=fi;s.instrumentalName=fi.name;s.instrumentalUrl=''}if(fv){s.fullFile=fv;s.fullName=fv.name;s.fullUrl=''}s.updated=Date.now();
 try{await put(s);await renderSongs();show('library')}catch(e){writeStatus('Sauvegarde impossible : espace insuffisant sur cet appareil ? '+e.message,'editStatus')}
}
async function stopEverything(){counting=false;await stopRecording();stopPlaying()}
function useTrackURL(){if(objectAudioURL){URL.revokeObjectURL(objectAudioURL);objectAudioURL=null}const src=trackSource(current,mode);const audio=$('songPlayer');audio.pause();audio.removeAttribute('src');audio.load();if(src instanceof Blob){objectAudioURL=URL.createObjectURL(src);audio.src=objectAudioURL}else if(typeof src==='string'&&src){audio.src=src}else audio.removeAttribute('src');audio.volume=Number($('volume').value)/100;audio.load()}
async function openSong(id){await stopEverything();current=await get(id);if(!current)return;mode=hasAudio(current,'instrumental')?'instrumental':hasAudio(current,'full')?'full':'instrumental';show('studio');$('studioTitle').textContent=current.title;$('readerText').textContent=current.lyrics||'Ajoute les paroles de cette chanson dans « Modifier ». ';selectMode(mode);writeStatus('Choisis ton mode, puis « Répéter » ou « Filmer ».')}
function selectMode(next){if(recording||counting)return;stopPlaying();mode=next;useTrackURL();$('chooseInstru').classList.toggle('active',mode==='instrumental');$('chooseVoix').classList.toggle('active',mode==='full');
 $('chooseInstru').disabled=!hasAudio(current,'instrumental');$('chooseVoix').disabled=!hasAudio(current,'full');
 const sourceFile=mode==='instrumental'?current?.instrumentalFile:current?.fullFile;
 const sourceName=mode==='instrumental'?current?.instrumentalName:current?.fullName;
 const label=mode==='instrumental'?'🎧 Instrumental + backs':'🎵 Chanson complète avec voix';
 $('modeInfo').textContent=hasAudio(current,mode)?label+' · Fichier : '+(sourceName||sourceFile?.name||'audio enregistré')+(sourceFile instanceof Blob?' ('+(sourceFile.size/1048576).toFixed(1)+' Mo)':''):'Audio manquant : ouvre « Modifier » pour importer le fichier.';
 const [a,b]=timingKeys(mode);$('start').value=Math.min(120,current[a]||0);$('duration').value=Math.min(600,current[b]||60);updateLabels();updateReader(0);$('play').disabled=!hasAudio(current,mode);$('record').disabled=!hasAudio(current,mode)||!current.lyrics}
function seconds(){const audio=$('songPlayer');return hasAudio(current,mode)&&Number.isFinite(audio.currentTime)?audio.currentTime:(performance.now()-clockStarted)/1000+timeBefore}
let dragOffset=0, drag=null, readerY=0;
function setImmersive(on){
 document.body.classList.toggle('immersive',on);
 const button=$('expandStage');
 if(button){button.textContent=on?'↙ Réduire':'⛶ Plein écran';button.setAttribute('aria-pressed',String(on))}
 if(current)updateReader($('songPlayer').currentTime||0);
 requestAnimationFrame(updateCameraFrame);
}
const reader=document.querySelector('#stage .reader');
reader.onpointerdown=e=>{
 if(!current)return;
 e.preventDefault();
 reader.setPointerCapture(e.pointerId);
 zoomPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
 if(zoomPointers.size===1){zoomPinch=null;drag={id:e.pointerId,start:e.clientY,origin:readerY,delta:0};}
 else if(zoomPointers.size===2){drag=null;zoomPinch={distance:Math.max(1,pinchDistance()),startZoom:cameraZoom};}
};
reader.onpointermove=e=>{
 if(!zoomPointers.has(e.pointerId))return;
 zoomPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
 if(zoomPointers.size>=2){
  if(zoomPinch)setCameraZoom(zoomPinch.startZoom*(pinchDistance()/zoomPinch.distance));
  return;
 }
 if(!drag||drag.id!==e.pointerId)return;
 drag.delta=e.clientY-drag.start;
 updateReader($('songPlayer').currentTime||0);
};
function endZoomPointer(e){
 zoomPointers.delete(e.pointerId);
 drag=null;
 if(zoomPointers.size<2)zoomPinch=null;
}
reader.onpointerup=endZoomPointer;
reader.onpointercancel=endZoomPointer;
reader.onlostpointercapture=endZoomPointer;
$('zoomReset').onclick=()=>setCameraZoom(1);
$('formatPortrait').onclick=()=>selectVideoFormat('portrait');
$('formatLandscape').onclick=()=>selectVideoFormat('landscape');
$('formatToggle').onclick=()=>selectVideoFormat(videoFormat==='portrait'?'landscape':'portrait');
if($('expandStage'))$('expandStage').onclick=()=>setImmersive(!document.body.classList.contains('immersive'));
function updateReader(t){if(!current)return;const el=$('readerText'),stage=$('stage');const offset=Number($('start').value),duration=Math.max(1,Number($('duration').value)),p=Math.max(0,Math.min(1,(t-offset)/duration));const height=stage.clientHeight,travel=Math.max(0,el.scrollHeight-height*.52);const base=height*.30-p*travel;
 readerY=Math.max(height*.30-travel,Math.min(height*.30,drag?drag.origin+drag.delta:base+dragOffset));
 if(drag)dragOffset=readerY-base;
 el.style.transform=`translateY(${readerY}px)`;
 const audio=$('songPlayer'),end=Number.isFinite(audio.duration)&&audio.duration>0?audio.duration:offset+duration;$('clock').textContent=fmt(t)+' / '+fmt(end);$('seek').max=end;$('seek').value=Math.min(t,end)}
function updateLabels(){$('fontText').textContent=$('fontSize').value+' px';$('startText').textContent=$('start').value+' s';$('durationText').textContent=$('duration').value+' s';$('volumeText').textContent=$('volume').value+' %';$('readerText').style.fontSize=$('fontSize').value+'px';$('songPlayer').volume=Number($('volume').value)/100;if(!playing)updateReader($('songPlayer').currentTime||0)}
function animate(){if(!playing)return;updateReader(seconds());raf=requestAnimationFrame(animate)}
async function play(){if(!current||!hasAudio(current,mode)){writeStatus('Il manque l’audio de ce mode.');return false}if(playing)return true;const audio=$('songPlayer');try{await audio.play()}catch(e){writeStatus('Lecture impossible : '+e.message);return false}playing=true;clockStarted=performance.now();$('play').textContent='❚❚ Pause';raf=requestAnimationFrame(animate);return true}
function pause(){if(!playing)return;timeBefore=seconds();playing=false;cancelAnimationFrame(raf);$('songPlayer').pause();$('play').textContent='▶ Reprendre'}
function stopPlaying(){dragOffset=0;drag=null;playing=false;cancelAnimationFrame(raf);const audio=$('songPlayer');audio.pause();try{audio.currentTime=0}catch{}timeBefore=0;$('play').textContent='▶ Répéter';updateReader(0)}
async function camera(){
 if(!navigator.mediaDevices?.getUserMedia){writeStatus('Caméra indisponible : ouvre l’application en HTTPS.');return false}
 try{
  if(stream)stream.getTracks().forEach(t=>t.stop());
  // On recent iOS Safari versions, a portrait (1080x1920) constraint may produce a landscape recording.
  // Ask for native landscape sensor dimensions and do the final portrait/landscape crop in our canvas.
  stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing},width:{ideal:1920},height:{ideal:1080}},audio:{echoCancellation:true,noiseSuppression:true}});
  const preview=$('cameraPreview');
  preview.srcObject=stream;
  try{await preview.play()}catch{}
  setCameraZoom(1);$('placeholder').classList.add('hidden');
  $('stage').classList.toggle('rear',facing==='environment');
  $('camToggle').textContent='📷 Caméra active';
  setImmersive(true);
  return true;
 }catch(e){writeStatus('Autorise caméra et micro sur ton iPhone : '+e.message);return false}
}
async function waitForCameraFrame(){
 const v=$('cameraPreview');
 if(v.readyState>=2&&v.videoWidth>0&&v.videoHeight>0)return true;
 return new Promise(resolve=>{
  let done=false;
  const finish=()=>{if(done)return;done=true;v.removeEventListener('loadeddata',check);v.removeEventListener('playing',check);resolve(v.readyState>=2&&v.videoWidth>0&&v.videoHeight>0)};
  const check=()=>{if(v.readyState>=2&&v.videoWidth>0&&v.videoHeight>0)finish()};
  v.addEventListener('loadeddata',check);v.addEventListener('playing',check);
  setTimeout(finish,3500);check();
 });
}
async function counter(){counting=true;for(let n=Number($('countdown').value);n>0;n--){writeStatus('Départ dans '+n+'…');await new Promise(r=>setTimeout(r,1000));if(!counting)return false}counting=false;return true}
function mime(){if(!window.MediaRecorder)return'';for(const s of ['video/mp4;codecs=h264,aac','video/mp4','video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'])if(MediaRecorder.isTypeSupported(s))return s;return''}
async function startRecording(){
 if(recording||counting||!current||!hasAudio(current,mode)){writeStatus('Ajoute les fichiers audio avant de filmer.');return}
 if(pendingVideoBlob){
  if(!confirm('Une vidéo précédente est encore en attente. La remplacer par une nouvelle prise ?'))return;
  discardPendingVideo(false);
 }

 if(!stream&&!await camera())return;if(!window.MediaRecorder){writeStatus('L’enregistrement vidéo n’est pas disponible dans ce navigateur.');return}
 if(!await waitForCameraFrame()){writeStatus('La caméra n’a pas encore produit d’image. Réessaie dans un instant.');return}
 if(!await counter())return;
 stopPlaying();let audioTracks=stream.getAudioTracks();
 try{recCtx=new(window.AudioContext||window.webkitAudioContext)();await recCtx.resume();recDest=recCtx.createMediaStreamDestination();recMic=recCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));recMic.connect(recDest);
 const audio=$('songPlayer');recSource=recCtx.createMediaElementSource(audio);recSource.connect(recDest);recSource.connect(recCtx.destination);audioTracks=recDest.stream.getAudioTracks()}
 catch(e){writeStatus('Mode de secours : le micro seul sera enregistré. '+e.message);audioTracks=stream.getAudioTracks()}
 recordedFormat=videoFormat;
 let videoTrack=startZoomCapture();
 if(!videoTrack){
  const proceed=confirm('Safari ne permet pas de garantir le format '+(recordedFormat==='portrait'?'vertical 9:16':'paysage 16:9')+'. Continuer au format natif de la caméra (qui peut être paysage) ?');
  if(!proceed){writeStatus('Enregistrement annulé : format demandé non disponible sur cet iPhone.');await releaseMixer();return}
  setCameraZoom(1);
  writeStatus('Mode de secours : le format vidéo final peut être différent du format choisi.');
 }
 const m=mime(),recordOptions=m?{mimeType:m,videoBitsPerSecond:3500000}:undefined;
 let rec=null;
 try{
  recStream=new MediaStream([videoTrack||stream.getVideoTracks()[0],...audioTracks]);
  rec=new MediaRecorder(recStream,recordOptions);
 }catch(e){
  if(!confirm('L’enregistrement au format '+(recordedFormat==='portrait'?'vertical':'paysage')+' a été refusé par Safari. Voulez-vous enregistrer au format natif, sans garantie ?')){writeStatus('Prise annulée : format non disponible.');await releaseMixer();return}
  stopZoomCapture();setCameraZoom(1);
  try{recStream=new MediaStream([...stream.getVideoTracks(),...audioTracks]);rec=new MediaRecorder(recStream,recordOptions)}
  catch(err){writeStatus('Enregistrement impossible : '+err.message);await releaseMixer();return}
 }
 recorder=rec;recChunks=[];
 recorder.ondataavailable=e=>{if(e.data?.size)recChunks.push(e.data)};
 recorder.onerror=e=>writeStatus('Erreur vidéo : '+(e.error?.message||'inconnue'));
 recorder.onstop=async()=>{
  const type=rec.mimeType||'video/mp4',blob=new Blob(recChunks,{type});
  await releaseMixer();
  if(!blob.size){writeStatus('Aucune vidéo enregistrée. Réessaie.');return}
  if(pendingVideoURL)URL.revokeObjectURL(pendingVideoURL);
  pendingVideoBlob=blob;pendingVideoURL=URL.createObjectURL(blob);
  const fileExt=type.includes('webm')?'webm':'mp4';
  const fileName=(current?.title||'OKAJB').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9_-]/g,'_')+'_'+Date.now()+'.'+fileExt;
  const out=$('videoOutput');out.replaceChildren();
  const heading=document.createElement('h2');heading.textContent='🎬 Ta prise est terminée';out.append(heading);
  const caption=document.createElement('p');caption.className='muted';caption.textContent='Regarde la vidéo avant de décider de l’enregistrer ou de la supprimer.';out.append(caption);
  const preview=document.createElement('video');preview.controls=true;preview.playsInline=true;preview.preload='metadata';preview.src=pendingVideoURL;out.append(preview);
  const videoMeta=document.createElement('p');videoMeta.className='muted';videoMeta.textContent='Vérification du format vidéo…';out.append(videoMeta);
  preview.addEventListener('loadedmetadata',()=>{
   const w=preview.videoWidth,h=preview.videoHeight;
   if(!w||!h){videoMeta.textContent='Dimensions non disponibles dans cet aperçu. Contrôle le format dans Photos.';return}
   const ratio=w/h,desired=recordedFormat==='portrait'?9/16:16/9;
   const ok=Math.abs(ratio-desired)<0.13;
   videoMeta.textContent='Vidéo : '+w+' × '+h+' pixels — '+(h>w?'verticale':'paysage')+'. '+(ok?'✓ Format '+(recordedFormat==='portrait'?'9:16':'16:9')+' conforme.':'⚠ Le format demandé n’a pas été respecté. Tu peux tout de même enregistrer la prise ou la supprimer.');
  });
  const actions=document.createElement('div');actions.className='reviewActions';
  const save=document.createElement('button');save.className='saveTake';save.textContent='💾 Enregistrer dans Photos';
  save.onclick=async()=>{
   if(!pendingVideoBlob){writeStatus('Cette prise a été supprimée.');return}
   try{
    const f=new File([pendingVideoBlob],fileName,{type});
    if(navigator.canShare?.({files:[f]})){
     await navigator.share({files:[f],title:fileName});
     writeStatus('Dans la feuille de partage, choisis « Enregistrer la vidéo ». Vérifie ensuite l’app Photos.');
    }else{
     const link=document.createElement('a');link.href=pendingVideoURL;link.download=fileName;link.textContent='';document.body.appendChild(link);link.click();link.remove();
     writeStatus('Téléchargement proposé. Retrouve la vidéo dans Fichiers, puis partage-la vers Photos.');
    }
   }catch(e){if(e?.name!=='AbortError')writeStatus('Enregistrement non confirmé : '+e.message)}
  };
  const remove=document.createElement('button');remove.className='deleteTake';remove.textContent='🗑 Supprimer la prise';
  remove.onclick=()=>{
   if(confirm('Supprimer cette prise vidéo ? Cette action est définitive si tu ne l’as pas enregistrée ailleurs.')){
    discardPendingVideo(false);
    writeStatus('La prise a été supprimée. Tu peux recommencer à filmer.');
   }
  };
  actions.append(save,remove);out.append(actions);
  writeStatus('Vidéo terminée : choisis Enregistrer ou Supprimer.');
  out.scrollIntoView({behavior:'smooth',block:'start'});
 }

 const saveVideoOnStop=recorder.onstop;
 try{recorder.start(800)}catch(e){
  if(zoomCaptureActive){
   if(!confirm('Safari ne peut pas lancer l’enregistrement avec le format choisi. Continuer au format natif, sans garantie ?')){writeStatus('Prise annulée : format non disponible.');await releaseMixer();return}
   stopZoomCapture();setCameraZoom(1);
   try{
    recStream=new MediaStream([...stream.getVideoTracks(),...audioTracks]);
    rec=new MediaRecorder(recStream,recordOptions);
    recorder=rec;recChunks=[];
    rec.ondataavailable=e=>{if(e.data?.size)recChunks.push(e.data)};
    rec.onerror=e=>writeStatus('Erreur vidéo : '+(e.error?.message||'inconnue'));
    rec.onstop=saveVideoOnStop;
    rec.start(800);
    writeStatus('Le zoom enregistré est indisponible dans ce navigateur : vidéo enregistrée sans zoom.');
   }catch(err){writeStatus('Enregistrement impossible : '+err.message);await releaseMixer();return}
  }else{writeStatus('Enregistrement impossible : '+e.message);await releaseMixer();return}
 }
 recording=true;$('recFlag').textContent='🔴 REC';$('recFlag').classList.add('recording');for(const id of ['camToggle','camFlip','chooseVoix','chooseInstru','record','seek','formatPortrait','formatLandscape','formatToggle'])$(id).disabled=true;
 if(!await play()){writeStatus('La caméra enregistre, mais la musique ne démarre pas. Arrête et recommence.')}
}
function discardPendingVideo(announce=true){
 if(pendingVideoURL){URL.revokeObjectURL(pendingVideoURL);pendingVideoURL=null}
 pendingVideoBlob=null;recChunks=[];
 $('videoOutput').replaceChildren();
 if(announce)writeStatus('Prise supprimée.');
}
async function releaseMixer(){stopZoomCapture();try{await recCtx?.close()}catch{}recCtx=recDest=recSource=recMic=recStream=null;
 // On Safari, createMediaElementSource() can only be called once per element.
 const old=$('songPlayer'),fresh=old.cloneNode(false);fresh.id='songPlayer';fresh.preload='metadata';old.replaceWith(fresh);fresh.onended=()=>{if(!recording)stopPlaying()};fresh.onloadedmetadata=()=>updateReader(0);if(current)useTrackURL()}
async function stopRecording(){if(!recording)return;recording=false;if(recorder?.state!=='inactive')recorder.stop();$('recFlag').textContent='PRÊT';$('recFlag').classList.remove('recording');for(const id of ['camToggle','camFlip','chooseVoix','chooseInstru','record','seek','formatPortrait','formatLandscape','formatToggle'])$(id).disabled=false;if(current){$('chooseInstru').disabled=!hasAudio(current,'instrumental');$('chooseVoix').disabled=!hasAudio(current,'full');$('record').disabled=!hasAudio(current,mode)||!current.lyrics}}
async function stopAll(){setImmersive(false);counting=false;await stopRecording();stopPlaying()}
// Private container v1: "OKAJB1\n" + uint32BE(JSON manifest length) + JSON + raw audio blobs.
// The catalogue on GitHub contains only public song titles. Local audio never goes through fetch().
const PRIVATE_MAGIC='OKAJB1\n';
const bytesText = b => new TextDecoder('utf-8',{fatal:true}).decode(b);
const encodeText = s => new TextEncoder().encode(s);
function uiImport(text,progress=-1){$('importStatus').textContent=text;const bar=$('importProgress');if(progress>=0){bar.classList.remove('hidden');bar.value=progress}else bar.classList.add('hidden')}
const cleanTitle = s=>String(s||'morceau').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9_-]/g,'_');
async function decodePrivate(file){
  if(!file || file.size<12)throw Error('Fichier vide ou non reconnu.');
  const head=new Uint8Array(await file.slice(0,11).arrayBuffer());
  const magic=bytesText(head.slice(0,7));
  if(magic!==PRIVATE_MAGIC)throw Error('Ce fichier n’est pas une bibliothèque .okajb.');
  const len=new DataView(head.buffer).getUint32(7,false);
  if(len<20||len>2*1024*1024||len>file.size-11)throw Error('En-tête de bibliothèque non valide.');
  const manifest=JSON.parse(bytesText(await file.slice(11,11+len).arrayBuffer()));
  if(manifest.format!=='OKAJB_PRIVATE_LIBRARY'||manifest.version!==1||!Array.isArray(manifest.songs)||manifest.songs.length>300)throw Error('Version de bibliothèque non compatible.');
  const payload=11+len,ids=new Set();
  for(const item of manifest.songs){
    if(typeof item.id!=='string'||!item.id||ids.has(item.id)||typeof item.title!=='string'||typeof item.lyrics!=='string')throw Error('Métadonnées des titres incorrectes.');
    ids.add(item.id);
    for(const key of ['instrumental','full'])if(item.tracks?.[key]){
      const part=item.tracks[key],offset=part.offset,size=part.size;
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(size)||size<=0||payload+offset+size>file.size)throw Error('Un fichier audio est incomplet.');
    }
  }
  return {manifest,payload};
}
async function restorePrivate(file){
  if(!file)return;
  if(file.name.toLowerCase().endsWith('.json'))return restoreLegacyJSON(file);
  try{
    uiImport('Lecture de la bibliothèque privée…',0);
    const {manifest,payload}=await decodePrivate(file);
    const songs=manifest.songs;
    const message=songs.length===1?'Réparer le titre « '+songs[0].title+' » avec les deux bons MP3 ? Les autres chansons resteront intactes.':'Importer '+songs.length+' titres ? Seuls ces titres seront remplacés, pas les autres.';
    if(!confirm(message)){uiImport('Import annulé.',-1);return}
    if(navigator.storage?.estimate){const estimate=await navigator.storage.estimate();const available=estimate.quota-estimate.usage;
      if(Number.isFinite(available)&&available<file.size*1.05&&!confirm('Espace de stockage local potentiellement insuffisant ('+Math.round(available/1048576)+' Mo estimés). Essayer quand même ?')){uiImport('Import annulé.',-1);return}
    }
    let n=0;
    for(const item of songs){
      const previous=await get(item.id);
      const s={...previous,id:item.id,title:item.title,lyrics:item.lyrics,offsetInstrumental:Number(item.offsetInstrumental)||0,offsetFull:Number(item.offsetFull)||0,durationInstrumental:Number(item.durationInstrumental)||60,durationFull:Number(item.durationFull)||60,updated:Date.now()};
      for(const [key,field] of [['instrumental','instrumentalFile'],['full','fullFile']]){
        const tr=item.tracks?.[key];
        if(tr){
          // Independent Blob avoids retaining a slice of a 200 MB file in iOS IndexedDB.
          const raw=await file.slice(payload+tr.offset,payload+tr.offset+tr.size).arrayBuffer();
          if(raw.byteLength!==tr.size)throw Error('MP3 incomplet pour '+item.title+' ('+key+').');
          if(tr.sha256){
            if(!/^[a-f0-9]{64}$/i.test(tr.sha256))throw Error('Empreinte MP3 non valide.');
            if(!crypto.subtle?.digest)throw Error('Vérification du fichier impossible sur ce navigateur.');
            const fingerprint=await crypto.subtle.digest('SHA-256',raw);
            const hex=Array.from(new Uint8Array(fingerprint)).map(x=>x.toString(16).padStart(2,'0')).join('');
            if(hex!==tr.sha256.toLowerCase())throw Error('Mauvais fichier audio pour '+item.title+' ('+key+'). Aucun remplacement effectué.');
            s[key+'Sha256']=hex;
          } else s[key+'Sha256']=null;
          s[field]=new Blob([raw],{type:'audio/mpeg'});
          s[key+'Name']=tr.name||item.id+'-'+key+'.mp3';
        }
      }
      s.instrumentalUrl='';s.fullUrl='';
      try{await put(s)}catch(err){throw Error('Enregistrement impossible après '+n+' titres (mémoire insuffisante ?) : '+err.message)}
      n++;uiImport('Import '+n+'/'+songs.length+' : '+item.title,n);
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    await renderSongs();const ready=(await getAll()).filter(s=>s.lyrics&&hasAudio(s,'instrumental')&&hasAudio(s,'full')).length;uiImport(songs.length===1?'✅ « '+songs[0].title+' » réparée avec ses deux pistes vérifiées. Les autres chansons sont conservées.':'✅ '+ready+' chansons complètes disponibles. Tes fichiers restent privés.',n);
    try{await navigator.storage?.persist?.()}catch{};
  }catch(e){uiImport('❌ Échec : '+e.message,-1);console.error(e)}
}
async function makeBackup(){
  try{
    const all=await getAll(),songs=[],blobs=[];let offset=0;
    for(const item of all){
      const song={id:item.id,title:item.title,lyrics:item.lyrics||'',offsetInstrumental:item.offsetInstrumental||0,offsetFull:item.offsetFull||0,durationInstrumental:item.durationInstrumental||60,durationFull:item.durationFull||60,tracks:{}};
      for(const [key,field] of [['instrumental','instrumentalFile'],['full','fullFile']]){
        const b=item[field];if(b instanceof Blob){const name=item[key+'Name']||b.name||cleanTitle(item.title)+'-'+key+'.mp3';song.tracks[key]={offset,size:b.size,name,type:b.type||'audio/mpeg'};offset+=b.size;blobs.push(b)}
      }
      songs.push(song);
    }
    const bytes=encodeText(JSON.stringify({format:'OKAJB_PRIVATE_LIBRARY',version:1,created:new Date().toISOString(),songs}));
    const header=new Uint8Array(11);header.set(encodeText(PRIVATE_MAGIC),0);new DataView(header.buffer).setUint32(7,bytes.length,false);
    const allBlob=new Blob([header,bytes,...blobs],{type:'application/octet-stream'}),url=URL.createObjectURL(allBlob);
    const a=document.createElement('a');a.href=url;a.download='OKAJB_SAUVEGARDE_'+new Date().toISOString().slice(0,10)+'.okajb';document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    uiImport('Sauvegarde créée ('+Math.round(allBlob.size/1048576)+' Mo). Vérifie sa présence dans Fichiers / Téléchargements.',-1);
  }catch(e){uiImport('Sauvegarde impossible : '+e.message,-1)}
}
async function resetLibrary(){if(!confirm('Supprimer les chansons enregistrées sur cet iPhone ? Vérifie que tu as conservé ton fichier privé .okajb avant de confirmer.'))return;await stopAll();await clearAll();current=null;await loadCatalog();await renderSongs();show('library');uiImport('Bibliothèque réinitialisée. Tu peux maintenant réimporter le fichier .okajb.',-1)}
// Backwards compatibility with previous V1.3 JSON exports, which may be very large.
async function restoreLegacyJSON(file){
  if(!confirm('Importer une ancienne sauvegarde JSON ? Préfère le format .okajb pour les grosses bibliothèques.'))return;
  try{
    uiImport('Lecture de l’ancienne sauvegarde…',0);
    const data=JSON.parse(await file.text());if(!Array.isArray(data.songs))throw Error('JSON non reconnu');
    let n=0;for(const item of data.songs){const s={...item};for(const key of ['instrumentalFile','fullFile'])if(s[key]?.data){const raw=s[key];const bin=atob(raw.data);const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);s[key]=new Blob([bytes],{type:raw.type||'audio/mpeg'});}
      s.updated=Date.now();await put(s);n++;uiImport('Ancienne sauvegarde '+n+'/'+data.songs.length,n)}await renderSongs();uiImport('✅ Ancienne sauvegarde importée.',n);
  }catch(e){uiImport('❌ Ancienne sauvegarde : '+e.message,-1)}
}
// interactions
$('search').oninput=renderSongs;$('addSong').onclick=()=>editSong(null);$('cancel').onclick=()=>show('library');$('save').onclick=saveSong;
$('lyricsFile').onchange=async e=>{const f=e.target.files[0];if(f){$('lyricsInput').value=await f.text();writeStatus('Paroles importées depuis '+f.name,'editStatus')}};
for(const [id,m,info] of [['uploadInstru','instrumental','instruInfo'],['uploadVoix','full','voixInfo']])$(id).onchange=()=>{$(info).textContent=$(id).files[0]?.name||'Aucun fichier';uploadedRemoved[m]=false};
$('clearInstru').onclick=()=>{uploadedRemoved.instrumental=true;$('uploadInstru').value='';$('instruInfo').textContent='Fichier retiré après sauvegarde'};
$('clearVoix').onclick=()=>{uploadedRemoved.full=true;$('uploadVoix').value='';$('voixInfo').textContent='Fichier retiré après sauvegarde'};
$('songs').onclick=async e=>{const b=e.target.closest('button[data-action]');if(!b)return;const id=b.dataset.id,action=b.dataset.action;if(action==='open')openSong(id);if(action==='edit')editSong(await get(id));if(action==='delete'&&confirm('Supprimer ce titre de la bibliothèque locale ?')){await del(id);renderSongs()}};
$('navLibrary').onclick=async()=>{await stopAll();show('library')};$('toLibrary').onclick=async()=>{await stopAll();show('library')};$('navStudio').onclick=()=>{if(current)show('studio');else writeStatus('Choisis une chanson dans la bibliothèque.','editStatus')};
$('chooseInstru').onclick=()=>selectMode('instrumental');$('chooseVoix').onclick=()=>selectMode('full');$('editCurrent').onclick=async()=>{await stopAll();editSong(current?await get(current.id):null)};
$('camToggle').onclick=async()=>{if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;$('cameraPreview').srcObject=null;$('placeholder').classList.remove('hidden');$('camToggle').textContent='📷 Activer caméra'}else await camera()};
$('camFlip').onclick=async()=>{facing=facing==='user'?'environment':'user';await camera()};
$('play').onclick=async()=>{if(recording)return;if(playing)pause();else await play()};$('record').onclick=startRecording;$('stop').onclick=stopAll;
$('songPlayer').onended=()=>{if(!recording)stopPlaying()};$('songPlayer').onloadedmetadata=()=>{if(!playing)updateReader(0)};
$('seek').oninput=e=>{if(!recording&&current){$('songPlayer').currentTime=Number(e.target.value);updateReader(Number(e.target.value))}};
for(const id of ['fontSize','start','duration','volume'])$(id).oninput=updateLabels;
$('rememberTiming').onclick=async()=>{if(!current)return;const[a,b]=timingKeys(mode);current[a]=Number($('start').value);current[b]=Number($('duration').value);await put(current);writeStatus('Réglage mémorisé pour cette version audio.')};
$('backup').onclick=makeBackup;$('resetLibrary').onclick=resetLibrary;$('restore').onchange=async e=>{await restorePrivate(e.target.files[0]);e.target.value=''};
async function init(){db=await openDB();try{await loadCatalog()}catch(e){console.warn('Catalogue:',e.message)}$('fontSize').value=36;updateLabels();selectVideoFormat('portrait');await renderSongs();
 if('serviceWorker'in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('./sw.js').catch(console.warn);setTimeout(()=>$('splash')?.remove(),1600)}
init().catch(e=>{console.error(e);alert('Impossible d’ouvrir OKAJB Prompteur : '+e.message)});
