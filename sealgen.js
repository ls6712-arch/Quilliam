/*SEALGEN-START*/
/* Realistic wax seals, drawn as SVG from a few choices. Shared by the app and the recipient's envelope page. */
const WAX={
  crimson:{n:"Crimson",b:"#a3161e",d:"#560a0e",h:"#e4675e"},
  burgundy:{n:"Burgundy",b:"#6d1424",d:"#33060e",h:"#b04454"},
  rose:{n:"Rose",b:"#c43a6c",d:"#741838",h:"#f394b8"},
  blush:{n:"Blush",b:"#e3a0b0",d:"#a8667a",h:"#fde0e7"},
  terracotta:{n:"Terracotta",b:"#b8532f",d:"#682611",h:"#ec9a74"},
  ochre:{n:"Ochre",b:"#c48a2a",d:"#734c0d",h:"#f4cd78"},
  sage:{n:"Sage",b:"#7f9a78",d:"#435b3c",h:"#c2d6bb"},
  emerald:{n:"Emerald",b:"#1f6b4a",d:"#0b3524",h:"#62b48e"},
  navy:{n:"Navy",b:"#22325f",d:"#0b132d",h:"#6a80bb"},
  lilac:{n:"Lilac",b:"#9b86c4",d:"#594684",h:"#dacdf2"},
  onyx:{n:"Onyx",b:"#28252b",d:"#060507",h:"#77727c"},
  ivory:{n:"Ivory",b:"#e6dbc2",d:"#9f8e6f",h:"#fffaf0"},
  gold:{n:"Gold leaf",b:"#c99a3a",d:"#694709",h:"#fff2b8",metal:1},
  silver:{n:"Silver",b:"#b7bdc6",d:"#565c66",h:"#ffffff",metal:1},
  copper:{n:"Copper",b:"#b8683a",d:"#5a2a10",h:"#ffc8a2",metal:1},
  pearl:{n:"Pearl",b:"#ece5dc",d:"#a99b8d",h:"#ffffff",pearl:1},
};
const SEAL_SHAPES={classic:"Classic pour",drip:"Dripping",heart:"Heart",oval:"Oval",octagon:"Octagon",scallop:"Scalloped",square:"Square",rope:"Rope edge"};
const SEAL_FINISHES={wax:"Wax",metallic:"Metallic",pearl:"Pearlescent",marble:"Marbled",antique:"Antique"};
const SEAL_EMBLEMS={initial:"Your initial",heart:"Heart",rose:"Rose",crown:"Crown",star:"Star",moon:"Moon",bee:"Bee",laurel:"Laurel",infinity:"Infinity",quill:"Quill",twohearts:"Two hearts",q:"Quilliam"};
function sealRng(seed){ let a=seed>>>0||1; return ()=>{ a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function sealHash(s){ let h=2166136261; for(const ch of s){ h^=ch.charCodeAt(0); h=Math.imul(h,16777619); } return h>>>0; }
function smoothPath(pts){ // closed Catmull-Rom through points
  const n=pts.length; let d=`M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for(let i=0;i<n;i++){ const p0=pts[(i-1+n)%n],p1=pts[i],p2=pts[(i+1)%n],p3=pts[(i+2)%n];
    d+=`C${(p1[0]+(p2[0]-p0[0])/6).toFixed(1)} ${(p1[1]+(p2[1]-p0[1])/6).toFixed(1)} ${(p2[0]-(p3[0]-p1[0])/6).toFixed(1)} ${(p2[1]-(p3[1]-p1[1])/6).toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`; }
  return d+"Z";
}
function sealOutline(shape,R){
  const out=[], N=72, ph=[R()*6.28,R()*6.28,R()*6.28,R()*6.28], am=[.035+R()*.02,.022+R()*.015,.012,.008];
  const wob=(a)=>1+am[0]*Math.sin(a*2+ph[0])+am[1]*Math.sin(a*5+ph[1])+am[2]*Math.sin(a*9+ph[2])+am[3]*Math.sin(a*14+ph[3]);
  if(shape==="heart"){ for(let i=0;i<N;i++){ const t=i/N*Math.PI*2, x=16*Math.pow(Math.sin(t),3), y=-(13*Math.cos(t)-5*Math.cos(2*t)-2*Math.cos(3*t)-Math.cos(4*t)); const w=1+.02*(R()-.5); out.push([100+x*4.9*w,104+y*4.9*w]); } return out; }
  if(shape==="octagon"){ for(let i=0;i<8;i++){ const a=i/8*Math.PI*2+Math.PI/8, r=84*(1+.02*(R()-.5)); const a2=a+Math.PI/8;
      out.push([100+Math.cos(a)*r,100+Math.sin(a)*r]); out.push([100+Math.cos(a2)*r*.94,100+Math.sin(a2)*r*.94]); } return out; }
  if(shape==="square"){ const s=72; for(let i=0;i<N;i++){ const a=i/N*Math.PI*2, c=Math.cos(a), sn=Math.sin(a), k=1/Math.pow(Math.pow(Math.abs(c),4)+Math.pow(Math.abs(sn),4),.25); out.push([100+c*s*1.08*k*wob(a),100+sn*s*1.08*k*wob(a)]); } return out; }
  if(shape==="scallop"){ for(let i=0;i<N;i++){ const a=i/N*Math.PI*2, r=80+7*Math.cos(a*12)+2*(R()-.5); out.push([100+Math.cos(a)*r,100+Math.sin(a)*r]); } return out; }
  const rx=shape==="oval"?70:84, ry=shape==="oval"?88:84;
  for(let i=0;i<N;i++){ const a=i/N*Math.PI*2, w=shape==="rope"?1+.01*(R()-.5):wob(a); out.push([100+Math.cos(a)*rx*w,100+Math.sin(a)*ry*w]); }
  return out;
}
function sealInner(shape){
  if(shape==="heart") return `<path d="M100 146C62 122 50 98 60 82s30-18 40 0c10-18 30-18 40 0s-2 40-40 64z"/>`;
  if(shape==="octagon") return `<polygon points="${Array.from({length:8},(_,i)=>{const a=i/8*Math.PI*2+Math.PI/8; return `${(100+Math.cos(a)*60).toFixed(1)},${(100+Math.sin(a)*60).toFixed(1)}`;}).join(" ")}"/>`;
  if(shape==="square") return `<rect x="48" y="48" width="104" height="104" rx="18"/>`;
  if(shape==="oval") return `<ellipse cx="100" cy="100" rx="48" ry="64"/>`;
  return `<circle cx="100" cy="100" r="58"/>`;
}
function sealEmblem(kind,fill,letter){
  const f=`fill="${fill}"`;
  switch(kind){
    case "initial": { const L=(letter||"A").slice(0,1).toUpperCase().replace(/[<>&"]/g,""); return `<text x="100" y="101" text-anchor="middle" dominant-baseline="central" font-family="Georgia,'Times New Roman',serif" font-style="italic" font-weight="700" font-size="76" ${f}>${L}</text>`; }
    case "heart": return `<path ${f} d="M100 132C66 110 58 90 66 78c8-12 26-12 34 4 8-16 26-16 34-4s0 32-34 54z"/>`;
    case "twohearts": return `<path ${f} d="M86 128C60 110 54 94 60 84s20-10 26 2c6-12 20-12 26-2s0 26-26 44z"/><path ${f} d="M118 120C96 104 92 90 97 82s17-8 21 2c5-10 17-10 22-2s-1 22-22 38z" opacity=".85"/>`;
    case "crown": return `<g ${f}><path d="M64 118l5-40 18 20 13-26 13 26 18-20 5 40z"/><rect x="64" y="121" width="72" height="9" rx="2"/><circle cx="69" cy="76" r="4.5"/><circle cx="100" cy="68" r="5"/><circle cx="131" cy="76" r="4.5"/></g>`;
    case "star": { let p=""; for(let i=0;i<10;i++){ const r=i%2?16:38, a=-Math.PI/2+i*Math.PI/5; p+=`${(100+Math.cos(a)*r).toFixed(1)},${(102+Math.sin(a)*r).toFixed(1)} `; } return `<polygon ${f} points="${p}"/>`; }
    case "moon": return `<g ${f}><path d="M114 64a38 38 0 1 0 0 72a30 30 0 1 1 0-72z"/><path d="M128 84l3 7 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/></g>`;
    case "rose": { let s=""; for(let i=0;i<6;i++){ s+=`<ellipse cx="100" cy="82" rx="12" ry="20" transform="rotate(${i*60} 100 100)"/>`; } return `<g ${f}>${s}<circle cx="100" cy="100" r="11"/></g><path d="M100 94c6 0 9 4 7 9s-9 6-12 2" fill="none" stroke="${fill}" stroke-width="2.4" opacity=".6"/>`; }
    case "bee": return `<g ${f}><ellipse cx="78" cy="84" rx="16" ry="11" transform="rotate(-30 78 84)" opacity=".85"/><ellipse cx="122" cy="84" rx="16" ry="11" transform="rotate(30 122 84)" opacity=".85"/><ellipse cx="100" cy="106" rx="15" ry="24"/><circle cx="100" cy="78" r="9"/></g><path d="M86 100h28M86 112h28" stroke="${fill}" stroke-width="0" />`;
    case "laurel": { let s=""; for(let i=0;i<7;i++){ const t=i/6, a=Math.PI*(.62+t*.72); const x=100+Math.cos(a)*40, y=100+Math.sin(a)*40; s+=`<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="5" ry="11" transform="rotate(${(a*180/Math.PI+30).toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`; const x2=200-x; s+=`<ellipse cx="${x2.toFixed(1)}" cy="${y.toFixed(1)}" rx="5" ry="11" transform="rotate(${(-(a*180/Math.PI)-30).toFixed(0)} ${x2.toFixed(1)} ${y.toFixed(1)})"/>`; }
      return `<g ${f}>${s}</g><text x="100" y="101" text-anchor="middle" dominant-baseline="central" font-family="Georgia,serif" font-style="italic" font-weight="700" font-size="40" ${f}>${(letter||"").slice(0,1).toUpperCase().replace(/[<>&"]/g,"")}</text>`; }
    case "infinity": return `<path d="M64 100c0-14 12-22 22-22 16 0 24 22 28 22s12-22 28-22c10 0 22 8 22 22s-12 22-22 22c-16 0-24-22-28-22s-12 22-28 22c-10 0-22-8-22-22z" fill="none" stroke="${fill}" stroke-width="9" transform="translate(-14 0) scale(1.14 1) translate(0 0)"/>`;
    case "quill": return `<g ${f}><path d="M132 60c-30 6-52 30-60 66l6 2c4-10 8-18 14-24 8 0 18-4 24-12-6 0-12 0-16-2 10-2 20-8 24-16-6 2-12 2-16 0 10-4 18-10 24-14z"/><path d="M70 136l8-12" stroke="${fill}" stroke-width="4" stroke-linecap="round"/></g>`;
    default: return `<text x="100" y="102" text-anchor="middle" dominant-baseline="central" font-family="Georgia,serif" font-style="italic" font-weight="700" font-size="74" ${f}>Q</text>`;
  }
}
function waxSeal(o){
  o=o||{}; const shape=SEAL_SHAPES[o.shape]?o.shape:"classic", wax=WAX[o.color]||WAX.crimson, finish=SEAL_FINISHES[o.finish]?o.finish:(wax.metal?"metallic":wax.pearl?"pearl":"wax"), emblem=SEAL_EMBLEMS[o.emblem]?o.emblem:"heart";
  const seed=sealHash([shape,o.color,emblem,finish,o.letter||""].join("|")), R=sealRng(seed), id="s"+seed.toString(36);
  const outline=smoothPath(sealOutline(shape,R));
  let drips="";
  if(shape==="drip"){ [-38,-6,30].forEach((dx0,k)=>{ const dx=dx0+(R()-.5)*10, x=100+dx, y=100+Math.sqrt(Math.max(0,80*80-dx*dx))-6, L=14+R()*20, w=6+R()*4;
      drips+=`<path d="M${(x-w-3).toFixed(1)} ${(y-4).toFixed(1)}C${(x-w).toFixed(1)} ${(y+L*.55).toFixed(1)} ${(x-w).toFixed(1)} ${(y+L).toFixed(1)} ${x.toFixed(1)} ${(y+L).toFixed(1)}C${(x+w).toFixed(1)} ${(y+L).toFixed(1)} ${(x+w).toFixed(1)} ${(y+L*.55).toFixed(1)} ${(x+w+3).toFixed(1)} ${(y-4).toFixed(1)}Z"/>`; }); }
  const b=wax.b, d=wax.d, h=wax.h, metal=finish==="metallic", pearl=finish==="pearl";
  const bodyGrad=metal
    ? `<linearGradient id="${id}b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${h}"/><stop offset=".22" stop-color="${b}"/><stop offset=".45" stop-color="${d}"/><stop offset=".6" stop-color="${b}"/><stop offset=".78" stop-color="${h}"/><stop offset="1" stop-color="${d}"/></linearGradient>`
    : `<radialGradient id="${id}b" cx=".34" cy=".3" r=".85"><stop offset="0" stop-color="${h}"/><stop offset=".38" stop-color="${b}"/><stop offset="1" stop-color="${d}"/></radialGradient>`;
  const faceGrad=`<radialGradient id="${id}f" cx=".6" cy=".66" r=".8"><stop offset="0" stop-color="${metal?h:b}"/><stop offset=".7" stop-color="${b}"/><stop offset="1" stop-color="${d}"/></radialGradient>`;
  const bevel=`<linearGradient id="${id}v" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${d}"/><stop offset=".5" stop-color="${b}"/><stop offset="1" stop-color="${h}"/></linearGradient>`;
  const rim=`<linearGradient id="${id}r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${h}" stop-opacity=".9"/><stop offset=".55" stop-color="${b}" stop-opacity="0"/><stop offset="1" stop-color="${d}" stop-opacity=".8"/></linearGradient>`;
  const spec=`<radialGradient id="${id}s" cx=".3" cy=".24" r=".42"><stop offset="0" stop-color="#fff" stop-opacity="${metal?.75:pearl?.7:.45}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`;
  const tex=`<filter id="${id}t" x="0" y="0" width="1" height="1"><feTurbulence type="fractalNoise" baseFrequency="${finish==="antique"?1.3:.95}" numOctaves="2" seed="${seed%997}"/><feColorMatrix values="0 0 0 0 ${finish==="antique"?.25:0}  0 0 0 0 ${finish==="antique"?.2:0}  0 0 0 0 ${finish==="antique"?.15:0}  0 0 0 ${finish==="antique"?.5:.22} 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>`;
  const marble=finish==="marble"?`<filter id="${id}m" x="0" y="0" width="1" height="1"><feTurbulence type="fractalNoise" baseFrequency=".018 .05" numOctaves="3" seed="${seed%911}"/><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 -14 6.6"/><feComposite in2="SourceGraphic" operator="in"/></filter>`:"";
  const shadow=`<filter id="${id}d" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#000" flood-opacity=".45"/></filter>`;
  const iri=pearl?`<linearGradient id="${id}i" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd6e7"/><stop offset=".35" stop-color="#d9ecff"/><stop offset=".65" stop-color="#e6ffe0"/><stop offset="1" stop-color="#ffe9c9"/></linearGradient>`:"";
  const antique=finish==="antique"?`<filter id="${id}a"><feColorMatrix type="saturate" values=".55"/></filter>`:"";
  const inner=sealInner(shape), ek=shape==="heart"?.78:shape==="oval"?.86:1, em=(fill)=>`<g transform="translate(100 ${shape==="heart"?96:100}) scale(${ek}) translate(-100 -100)">${sealEmblem(emblem,fill,o.letter)}</g>`;
  const ropeRing=shape==="rope"?`<circle cx="100" cy="100" r="70" fill="none" stroke="${d}" stroke-width="9" stroke-dasharray="5 4" opacity=".7"/><circle cx="100" cy="100" r="70" fill="none" stroke="${h}" stroke-width="3" stroke-dasharray="5 4" stroke-dashoffset="2" opacity=".55"/>`:"";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs>${bodyGrad}${faceGrad}${bevel}${rim}${spec}${tex}${marble}${shadow}${iri}${antique}<clipPath id="${id}c"><path d="${outline}"/>${drips}</clipPath></defs>
<g${antique?` filter="url(#${id}a)"`:""}>
<g filter="url(#${id}d)"><path d="${outline}" fill="url(#${id}b)"/><g fill="url(#${id}b)">${drips}</g></g>
<path d="${outline}" fill="none" stroke="url(#${id}r)" stroke-width="3"/>
${ropeRing}
<g fill="url(#${id}f)">${inner}</g>
<g fill="none" stroke="url(#${id}v)" stroke-width="5">${inner}</g>
<g fill="none" stroke="${d}" stroke-width="1.2" opacity=".55" transform="translate(100 100) scale(.94) translate(-100 -100)">${inner}</g>
<g opacity=".9" transform="translate(1.8 2.2)">${em(d)}</g>
<g opacity=".75" transform="translate(-1.4 -1.4)">${em(h)}</g>
${em(metal?`url(#${id}f)`:b)}
<g clip-path="url(#${id}c)">${pearl?`<rect width="200" height="200" fill="url(#${id}i)" opacity=".38"/>`:""}${marble?`<rect width="200" height="200" fill="${h}" filter="url(#${id}m)" opacity=".42"/>`:""}<rect width="200" height="200" fill="#000" filter="url(#${id}t)"/><ellipse cx="70" cy="58" rx="56" ry="40" fill="url(#${id}s)"/></g>
</g></svg>`;
}
/*SEALGEN-END*/
