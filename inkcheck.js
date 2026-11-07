/*INKCHECK-START*/
/* Handwriting check. Looks at HOW the pen moved, not what the words say.
   Shared by the app (live meter, Quilliam's remarks) and the server (which decides the stamp).
   Ink format: {v:1, w, h, r:[x,y,w,h] pad box within the letter (0..1), s:[[pen, color, [x,y,p,t, x,y,p,t, ...]], ...]}
   x,y are 0..10000 across the writing area, p is pressure 0..100, t is ms since the first point. */
var INK_LIMITS={strokes:1500,points:80000};
function inkStats(a){ const n=a.length; if(!n) return {mean:0,sd:0,cv:0,med:0}; const mean=a.reduce((s,v)=>s+v,0)/n; const sd=Math.sqrt(a.reduce((s,v)=>s+(v-mean)**2,0)/n); const srt=[...a].sort((x,y)=>x-y); return {mean,sd,cv:mean?sd/mean:0,med:srt[n>>1]}; }
function inkValid(ink){
  if(!ink||typeof ink!=="object"||!Array.isArray(ink.s)||ink.s.length>INK_LIMITS.strokes) return false;
  if(!(ink.w>0&&ink.w<10000&&ink.h>0&&ink.h<10000)) return false;
  let pts=0; for(const s of ink.s){ if(!Array.isArray(s)||!Array.isArray(s[2])||s[2].length%4) return false; pts+=s[2].length/4; if(pts>INK_LIMITS.points) return false;
    for(const v of s[2]) if(typeof v!=="number"||!isFinite(v)||v<-1e3||v>1e8) return false; }
  return true;
}
function analyzeInk(ink){
  const out={verdict:"short",score:50,facts:{strokes:0,seconds:0,inkPx:0,undos:ink&&ink.u|0},reasons:[],flags:[]};
  if(!inkValid(ink)||!ink.s.length) return out;
  const W=ink.w/10000, H=ink.h/10000;
  const strokes=ink.s.map(s=>{ const a=s[2], p=[]; for(let i=0;i<a.length;i+=4) p.push([a[i]*W,a[i+1]*H,a[i+2],a[i+3]]); return p; }).filter(p=>p.length);
  const dts=[], speedCVs=[], stepCVs=[], straight=[], gaps=[], sizes=[], turns=[]; let inkPx=0, fastPts=0, totalPts=0;
  strokes.forEach((p,k)=>{
    let len=0; const sp=[], steps=[]; let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9, turn=0, lastAng=null;
    for(let i=0;i<p.length;i++){ const [x,y]=p[i]; minX=Math.min(minX,x); maxX=Math.max(maxX,x); minY=Math.min(minY,y); maxY=Math.max(maxY,y);
      if(i){ const dx=x-p[i-1][0], dy=y-p[i-1][1], d=Math.hypot(dx,dy), dt=p[i][3]-p[i-1][3]; len+=d; totalPts++; dts.push(dt); if(dt<2.5) fastPts++;
        if(dt>0&&d>0) sp.push(d/dt); if(d>0) steps.push(d);
        if(d>1.5){ const ang=Math.atan2(dy,dx); if(lastAng!==null){ let da=Math.abs(ang-lastAng); if(da>Math.PI) da=2*Math.PI-da; turn+=da; } lastAng=ang; } } }
    inkPx+=len; sizes.push(Math.max(maxY-minY,(maxX-minX)*.5)); turns.push(turn);
    if(sp.length>=5) speedCVs.push(inkStats(sp).cv);
    if(steps.length>=5) stepCVs.push(inkStats(steps).cv);
    if(len>25&&p.length>=5){ const [x0,y0]=p[0], [x1,y1]=p[p.length-1], ch=Math.hypot(x1-x0,y1-y0)||1; let dev=0;
      for(const [x,y] of p) dev=Math.max(dev,Math.abs((x1-x0)*(y0-y)-(x0-x)*(y1-y0))/ch); straight.push(dev/len); }
    if(k) gaps.push(p[0][3]-strokes[k-1][strokes[k-1].length-1][3]);
  });
  const t0=strokes[0][0][3], t1=strokes[strokes.length-1].slice(-1)[0][3];
  const seconds=Math.max(0,(t1-t0)/1000), dt=inkStats(dts.filter(v=>v>=0)), spCV=inkStats(speedCVs), stCV=inkStats(stepCVs), gp=inkStats(gaps.filter(g=>g>=0)), sz=inkStats(sizes);
  const straightFrac=straight.length?straight.filter(v=>v<.012).length/straight.length:0;
  const curvy=turns.filter(t=>t>1.2).length/strokes.length;
  const pxPerSec=seconds?inkPx/seconds:Infinity;
  Object.assign(out.facts,{strokes:strokes.length,seconds:Math.round(seconds),inkPx:Math.round(inkPx),speedVariation:+spCV.med.toFixed(2),spacingVariation:+stCV.med.toFixed(2),pauseVariation:+gp.cv.toFixed(2),straightShare:+straightFrac.toFixed(2),curvyShare:+curvy.toFixed(2),medianStrokeSize:+(sz.med/Math.max(1,ink.h)).toFixed(3),pointGapMs:Math.round(dt.med),inkPerSecond:Math.round(pxPerSec)});
  // Evidence of a living hand
  let s=50; const R=[], B=[], F=out.flags;
  if(totalPts>20 && fastPts/totalPts>.5){ s-=55; F.push("too_fast_points"); B.push("pen points arrived faster than any real device sends them"); }
  if(speedCVs.length>=5){ if(spCV.med>=.28){ s+=22; R.push("the pen speeds up and slows down like a real hand"); } else if(spCV.med<.08){ s-=38; F.push("constant_speed"); B.push("every stroke moves at exactly the same speed"); } }
  // Hands are sampled over time, so the gaps between points change as the pen speeds up and slows down.
  // Scripted input is interpolated, so the points come out evenly spaced.
  if(stepCVs.length>=5){ if(stCV.med<.06){ s-=30; F.push("even_spacing"); B.push("the pen points are spaced perfectly evenly, like a program drew them"); } else if(stCV.med>=.25) s+=6; }
  if(straight.length>=6){ if(straightFrac>.85){ s-=26; F.push("ruler_lines"); B.push("the lines are perfectly straight, like a ruler drew them"); } else if(straightFrac<.6){ s+=8; } }
  if(curvy>=.25){ s+=10; R.push("loops and curves, like real letters"); }
  if(gaps.length>=8){ if(gp.cv>=.35){ s+=10; R.push("natural pauses between strokes"); } else if(gp.cv<.08){ s-=22; F.push("metronome_pauses"); B.push("the pauses between strokes are identical"); } }
  if(pxPerSec>6000&&seconds>0){ s-=20; F.push("superhuman_speed"); B.push("written impossibly fast"); }
  if((ink.u|0)>0){ s+=Math.min(6,ink.u*2); R.push("a few second thoughts (undo)"); }
  // Is it writing, or a doodle?
  const enough=strokes.length>=12 && seconds>=10 && inkPx>=ink.w*2;
  const scribble=sz.med>ink.h*.3;
  if(scribble){ s-=12; F.push("scribble"); B.push("big scribbles rather than letters"); }
  out.score=Math.max(0,Math.min(100,Math.round(s)));
  // Two or more machine signs together = a script. One alone could be a privacy browser blurring timestamps.
  const severe=F.filter(f=>["too_fast_points","constant_speed","even_spacing","ruler_lines","metronome_pauses","superhuman_speed"].includes(f)).length;
  out.verdict=severe>=2&&out.score<45?"machine":!enough?"short":out.score>=62&&!scribble&&!severe?"human":"unsure";
  out.reasons=out.verdict==="human"?R:out.verdict==="machine"?B:[...B,...R];
  return out;
}
/* Typing check: real typing has an uneven rhythm, some corrections, and very little pasting. */
function analyzeTyping(t){
  const out={verdict:"short",score:50,facts:{},reasons:[],flags:[]};
  if(!t||typeof t!=="object") return out;
  const keys=t.keys|0, backs=t.backs|0, paste=Math.max(0,Math.min(1,+t.paste||0));
  const gaps=(Array.isArray(t.gaps)?t.gaps:[]).filter(g=>typeof g==="number"&&g>0&&g<3000).slice(0,400), g=inkStats(gaps);
  Object.assign(out.facts,{keys,backs,pasted:Math.round(paste*100),rhythmVariation:+g.cv.toFixed(2),medianKeyMs:Math.round(g.med)});
  let s=50;
  if(paste>.2){ s-=50; out.flags.push("pasted"); out.reasons.push(Math.round(paste*100)+"% of the text was pasted in"); }
  if(gaps.length>=30){ if(g.cv>=.45){ s+=22; out.reasons.push("an uneven, human typing rhythm"); } else if(g.cv<.15){ s-=35; out.flags.push("robot_rhythm"); out.reasons.push("every key pressed at the same pace"); } }
  if(g.med&&g.med<25){ s-=30; out.flags.push("too_fast"); out.reasons.push("typed faster than humanly possible"); }
  if(backs>=2){ s+=8; out.reasons.push("real corrections along the way"); }
  out.score=Math.max(0,Math.min(100,Math.round(s)));
  out.verdict=out.flags.length&&out.score<45?"machine":keys<40||gaps.length<30?"short":out.score>=62&&!out.flags.length?"human":"unsure";
  return out;
}
/*INKCHECK-END*/
