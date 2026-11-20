import { L3 } from './lumen3.mjs';

export async function createOuroborosStage({ canvas, night = false, onTap = () => false, onKey = () => false, onNight = () => {}, signal }) {
const root = canvas.closest('#st-splash');
if (!root) throw new Error('Startup stage must be inside #st-splash');
const yieldForInteraction = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
let renderer;
const checkCancelled = () => {
  if (!signal?.aborted) return;
  try { renderer?.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {}
  throw new DOMException('Startup animation initialization cancelled', 'AbortError');
};
let budgetStarted = performance.now();
async function yieldWithinBudget() {
  if (performance.now() - budgetStarted < 8) return;
  await yieldForInteraction();
  checkCancelled();
  budgetStarted = performance.now();
}
await yieldForInteraction();
checkCancelled();
const listeners = [];
const listen = (target, type, handler, options) => { target.addEventListener(type, handler, options); listeners.push([target, type, handler, options]); };
/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
const TAU=Math.PI*2;
const add=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]], sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const mul=(a,s)=>[a[0]*s,a[1]*s,a[2]*s], dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const vlen=a=>Math.hypot(a[0],a[1],a[2]), norm=a=>{const l=vlen(a)||1;return [a[0]/l,a[1]/l,a[2]/l];};
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x)), mix=(a,b,t)=>a+(b-a)*t;
const lerp3=(a,b,t)=>[mix(a[0],b[0],t),mix(a[1],b[1],t),mix(a[2],b[2],t)];
const sstep=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
const fract=x=>x-Math.floor(x);
function spline(pts){
  const n=pts.length;
  const m=i=>{const a=pts[Math.max(i-1,0)],b=pts[Math.min(i+1,n-1)];return (b[1]-a[1])/(b[0]-a[0]);};
  return x=>{
    if(x<=pts[0][0])return pts[0][1]; if(x>=pts[n-1][0])return pts[n-1][1];
    let k=0; while(x>pts[k+1][0])k++;
    const x0=pts[k][0],y0=pts[k][1],x1=pts[k+1][0],y1=pts[k+1][1],h=x1-x0,t=(x-x0)/h,t2=t*t,t3=t2*t;
    return (2*t3-3*t2+1)*y0+(t3-2*t2+t)*m(k)*h+(-2*t3+3*t2)*y1+(t3-t2)*m(k+1)*h;
  };
}
let seed=20261114;
const rnd=()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};


/* ------------------------------------------------------------------ */
/*  The path: an outer ring woven with an inner ∞ (one closed loop,     */
/*  shared by two serpents), arc-length parametrised → Fourier series. */
/* ------------------------------------------------------------------ */
const RC=5.2, GA=5.15, GB=4.6, GH=0.78, KF=48;
const FC=[],FSn=[]; let CIRC=0;
{
  const pts=[], seg=async (n,fn)=>{for(let i=0;i<n;i++){pts.push(fn(i/n));if(i%256===0)await yieldWithinBudget();}};
  await seg(4000,u=>{const th=u*Math.PI;return [RC*Math.cos(th),RC*Math.sin(th),-GH*Math.cos(th)];});
  await seg(4000,u=>{const t=1.5*Math.PI+u*Math.PI;return [GA*Math.sin(t),GB*Math.sin(t)*Math.cos(t),GH];});
  await seg(4000,u=>{const th=-u*Math.PI;return [RC*Math.cos(th),RC*Math.sin(th),GH*Math.cos(th)];});
  await seg(4000,u=>{const t=1.5*Math.PI-u*Math.PI;return [GA*Math.sin(t),GB*Math.sin(t)*Math.cos(t),-GH];});
  for(let i=0;i<pts.length;i++){pts[i][0]=-pts[i][0];if(i%256===0)await yieldWithinBudget();}
  const arc=P=>{const c=[0];for(let i=1;i<=P.length;i++)c.push(c[i-1]+vlen(sub(P[i%P.length],P[i-1])));return c;};
  const resample=async (P,N)=>{const c=arc(P),L=c[P.length],out=[];let j=0;
    for(let i=0;i<N;i++){const st=i/N*L;while(c[j+1]<st)j++;const fr=(st-c[j])/(c[j+1]-c[j]);out.push(add(P[j],mul(sub(P[(j+1)%P.length],P[j]),fr)));if(i%256===0)await yieldWithinBudget();}
    return {out,L};};
  const A=await resample(pts,4096), ds=A.L/4096, SIG=0.45, w=Math.ceil(3*SIG/ds), ker=[]; let ks=0;
  for(let i=-w;i<=w;i++){const v=Math.exp(-0.5*Math.pow(i*ds/SIG,2));ker.push(v);ks+=v;}
  const Bp=[];
  for(let i=0;i<A.out.length;i++){let a=[0,0,0];for(let k=-w;k<=w;k++)a=add(a,mul(A.out[(i+k+4096)%4096],ker[k+w]));Bp.push(mul(a,1/ks));if(i%64===0)await yieldWithinBudget();}
  const R=await resample(Bp,1024), S=R.out; CIRC=R.L;
  const NF=S.length;
  for(let k=0;k<KF;k++){
    let a=[0,0,0],b=[0,0,0];
    for(let i=0;i<NF;i++){const u=i/NF*TAU;a=add(a,mul(S[i],Math.cos(k*u)));b=add(b,mul(S[i],Math.sin(k*u)));}
    const sc=k?2/NF:1/NF; FC.push(mul(a,sc)); FSn.push(mul(b,sc));
    await yieldWithinBudget();
  }
}
/* the same frame on the CPU (used to keep each dragon's head upright) */
function pathFrameCPU(u,time){
  const c=FC[0].slice(),d=[0,0,0];
  for(let k=1;k<KF;k++){const ck=Math.cos(k*u),sk=Math.sin(k*u),A=FC[k],B=FSn[k];
    for(let i=0;i<3;i++){c[i]+=A[i]*ck+B[i]*sk;d[i]+=k*(B[i]*ck-A[i]*sk);}}
  const t=time*0.35;
  c[2]+=0.10*Math.sin(2*u-t)+0.05*Math.sin(4*u+t*1.3);
  d[2]+=0.20*Math.cos(2*u-t)+0.20*Math.cos(4*u+t*1.3);
  const b=1+0.012*Math.sin(time*0.6); c[0]*=b;c[1]*=b;d[0]*=b;d[1]*=b;
  const T=norm(d),D=norm(cross([0,0,1],T)),S=cross(T,D);
  return {C:c,T,D,S};
}

/* ------------------------------------------------------------------ */
/*  Dragon-serpent geometry in "path space": x = arc length (head at   */
/*  0+, body toward −x), y = dorsal, z = lateral.                      */
/* ------------------------------------------------------------------ */
const HX=1.34, HS=1.30;                    // head scale: length, cross-section
const HLm=1.72, HL=HLm*HX;                 // head length (model / world)
const TGAP=1.20;                           // free space between snout and the other's tail tip
const GAP=HL+TGAP, LB=CIRC/2-GAP, TOTAL=HL+LB;
const CONE=1.25;                           // spiral tail-horn length
const GOLD=[CONE+0.07,CONE+0.18,CONE+0.29];
const lenOf=x=>(HL-x)/TOTAL;
const SPIN0=((Math.PI*RC/2)/CIRC-0.5*HL/CIRC)*TAU;   // first head at the top of the ring
const MAT={BODY:0,HEAD:1,HORN:2,GOLD:3,CONE:4,EYE:5,WHISK:6,SPIKE:7,GEM:8};
/* ------------------------------------------------------------------ */
/*  ENTRY TRACKS — each dragon flies in along its own spiral that      */
/*  merges tangentially onto the outer ring; the body follows the head */
/*  like a train on a track, so the coil forms by itself.              */
/* ------------------------------------------------------------------ */
const NE=96, ENTRY={R1:27, TH:1.25*Math.PI, Z1:4.5, JOIN_DEG:90, EXP:2.2};   /* 第二条龙的 TH 自动求解：起点正好在第一条的对侧 */
function pathStatic(u){
  const c=FC[0].slice(),d=[0,0,0];
  for(let k=1;k<KF;k++){const ck=Math.cos(k*u),sk=Math.sin(k*u),A=FC[k],B=FSn[k];
    for(let i=0;i<3;i++){c[i]+=A[i]*ck+B[i]*sk;d[i]+=k*(B[i]*ck-A[i]*sk);}}
  return {C:c,T:norm(d)};
}
const wrapPi=a=>a-TAU*Math.round(a/TAU);
function onRing(u){            /* a point that sits on the pure ring arc (not where the ∞ lobe touches it) */
  for(const du of [-0.12,-0.06,0,0.06,0.12]){
    const {C,T}=pathStatic(u+du), r=Math.hypot(C[0],C[1]);
    if(Math.abs(r-RC)>0.06)return false;
    if(Math.abs((C[0]*T[0]+C[1]*T[1])/r)>0.03)return false;       /* tangent ⟂ radius */
  }
  return true;
}
async function pickJoin(){            /* ring point nearest JOIN_DEG whose 180°-twin is also on the ring */
  let best=1e9,bu=0;
  for(let i=0;i<4096;i++){
    if(i%4===0)await yieldWithinBudget();
    const u=i/4096*TAU; if(!onRing(u)||!onRing(u+Math.PI))continue;
    const {C}=pathStatic(u), e=Math.abs(wrapPi(Math.atan2(C[1],C[0])-ENTRY.JOIN_DEG*Math.PI/180));
    if(e<best){best=e;bu=u;}
  }
  return bu;
}
function entryStart(u,TH){const {C:P,T}=pathStatic(u),sg=Math.sign(P[0]*T[1]-P[1]*T[0])||1;return Math.atan2(P[1],P[0])-sg*TH;}
async function buildEntry(u,TH,Z1){
  const {C:P,T}=pathStatic(u), phj=Math.atan2(P[1],P[0]), Rj=Math.hypot(P[0],P[1]);
  const sg=Math.sign(P[0]*T[1]-P[1]*T[0])||1, M=4000, raw=[], slope=T[2]/Math.max(Math.hypot(T[0],T[1]),1e-6);
  for(let i=0;i<=M;i++){
    const q=i/M, th=q*TH, r=Rj+(ENTRY.R1-Rj)*Math.pow(q,ENTRY.EXP), ph=phj-sg*th, sz=q*q*(3-2*q);
    raw.push([r*Math.cos(ph), r*Math.sin(ph), P[2]*(1-sz)+Z1*sz-slope*Rj*th*Math.exp(-th/0.8)]);   /* 平面内的圆润螺旋；并入点的深度坡度与外环一致 */   /* 平面内的圆润螺旋：不上下抖、不猛扑镜头 */
    if(i%128===0)await yieldWithinBudget();
  }
  const cum=[0]; for(let i=1;i<raw.length;i++){cum.push(cum[i-1]+vlen(sub(raw[i],raw[i-1])));if(i%128===0)await yieldWithinBudget();}
  const L=cum[cum.length-1], step=L/(NE-1), pts=[]; let j=0;
  for(let n=0;n<NE;n++){const s=n*step; while(j<raw.length-2&&cum[j+1]<s)j++;
    const f=(s-cum[j])/Math.max(cum[j+1]-cum[j],1e-9); pts.push(add(raw[j],mul(sub(raw[j+1],raw[j]),Math.min(Math.max(f,0),1))));}
  pts[0]=P.slice();
  const ghost=pathStatic(u+step*TAU/CIRC).C;   /* 样条在并入点之前的“虚点”= 环路上往前一步，保证曲率连续 */
  return {u,pts,step,L,H:0,ghost,TH};
}
const U0=await pickJoin();
const ENT=await (async()=>{
  const sA=entryStart(U0,ENTRY.TH); let best=1e9,thB=ENTRY.TH;
  let iterations=0;
  for(let th=0.5*Math.PI;th<=3.0*Math.PI;th+=0.0025){const e=Math.abs(wrapPi(entryStart(U0+Math.PI,th)-sA-Math.PI)); if(e<best-1e-9){best=e;thB=th;}if(++iterations%64===0)await yieldWithinBudget();}
  return [await buildEntry(U0,ENTRY.TH,ENTRY.Z1),await buildEntry(U0+Math.PI,thB,-ENTRY.Z1)];   /* 一前一后交错掠过 */
})();
await yieldForInteraction();
checkCancelled();
function entryEval(E,d){
  const P=E.pts,n=NE,Lm=E.step*(n-1),f=Math.min(Math.max(d,0),Lm-1e-4)/E.step,i=Math.floor(f),t=f-i;
  const g=k=>P[Math.max(0,Math.min(n-1,k))];
  const p1=g(i),p2=g(i+1),p0=i>0?g(i-1):E.ghost,p3=i+2<n?g(i+2):sub(mul(p2,2),p1);
  const A=mul(p1,2),B=sub(p2,p0),Cc=add(sub(mul(p0,2),mul(p1,5)),sub(mul(p2,4),p3)),Dd=add(sub(mul(p1,3),p0),sub(p3,mul(p2,3)));
  let C=mul(add(add(A,mul(B,t)),add(mul(Cc,t*t),mul(Dd,t*t*t))),0.5);
  const T=norm(mul(add(B,add(mul(Cc,2*t),mul(Dd,3*t*t))),-0.5));
  if(d>Lm)C=sub(C,mul(T,d-Lm));
  return {C,T};
}
function trackFrameCPU(i,x,time){
  const E=ENT[i],a=x+E.H;
  if(a>=0)return pathFrameCPU(E.u+a*TAU/CIRC,time);
  const d=-a,e=entryEval(E,d),C=e.C.slice(),b=1+0.012*Math.sin(time*0.6),ue=E.u-d*TAU/CIRC,tt=time*0.35;
  C[0]*=b;C[1]*=b;C[2]+=(0.10*Math.sin(2*ue-tt)+0.05*Math.sin(4*ue+tt*1.3))*Math.exp(-d*d/40);
  const T=e.T,D=norm(cross([0,0,1],T));
  return {C,T,D,S:cross(T,D)};
}
const G={pos:[],nor:[],inf:[],idx:[]};
const hs=p=>[p[0]*HX,p[1]*HS,p[2]*HS];

async function addLoft(rings){
  const K=rings.length,M=rings[0].length,base=G.pos.length/3,n=K*M;
  const P=new Float32Array(n*3),Nm=new Float32Array(n*3);
  for(let k=0;k<K;k++){
    for(let j=0;j<M;j++){const v=rings[k][j];P.set(v.p,(k*M+j)*3);G.inf.push(v.f[0],v.f[1],v.f[2],v.f[3]);}
    await yieldWithinBudget();
  }
  const map=new Map(),rep=new Int32Array(n);
  for(let i=0;i<n;i++){
    const key=Math.round(P[i*3]*4000)+','+Math.round(P[i*3+1]*4000)+','+Math.round(P[i*3+2]*4000);
    if(!map.has(key))map.set(key,i); rep[i]=map.get(key);
    if(i%256===0) await yieldWithinBudget();
  }
  const g=i=>[P[i*3],P[i*3+1],P[i*3+2]];
  const face=(a,b,c)=>{
    const fn=cross(sub(g(b),g(a)),sub(g(c),g(a)));
    for(const i of [rep[a],rep[b],rep[c]]){Nm[i*3]+=fn[0];Nm[i*3+1]+=fn[1];Nm[i*3+2]+=fn[2];}
    G.idx.push(base+a,base+b,base+c);
  };
  for(let k=0;k<K-1;k++){
    for(let j=0;j<M-1;j++){const a=k*M+j,b=a+1,c=a+M,d=c+1;face(a,c,b);face(b,c,d);}
    await yieldWithinBudget();
  }
  let sgn=0;const out=new Float32Array(n*3);
  for(let k=0;k<K;k++){
    let cen=[0,0,0];for(let j=0;j<M;j++)cen=add(cen,g(k*M+j));cen=mul(cen,1/M);
    for(let j=0;j<M;j++){const i=k*M+j,r=rep[i];let nn=[Nm[r*3],Nm[r*3+1],Nm[r*3+2]];
      if(vlen(nn)<1e-12)nn=[1,0,0];nn=norm(nn);out.set(nn,i*3);sgn+=dot(nn,sub(g(i),cen));}
    await yieldWithinBudget();
  }
  const s=sgn<0?-1:1;
  for(let i=0;i<n*3;i++){G.pos.push(P[i]);G.nor.push(out[i]*s);}
}
async function addTube(path,radFn,sides,fFn,squash=[1,1]){
  const rings=[],n=path.length;
  for(let i=0;i<n;i++){
    const d=norm(sub(path[Math.min(i+1,n-1)],path[Math.max(i-1,0)]));
    let u=cross(d,[0,0,1]); if(vlen(u)<1e-3)u=cross(d,[1,0,0]); u=norm(u); const v=norm(cross(d,u));
    const t=i/(n-1),r=radFn(t),ring=[];
    for(let j=0;j<=sides;j++){const ph=j/sides*TAU;
      ring.push({p:add(path[i],add(mul(u,r*Math.cos(ph)*squash[0]),mul(v,r*Math.sin(ph)*squash[1]))),f:fFn(t,j/sides)});}
    rings.push(ring);
  }
  await addLoft(rings);
}
/* flat feather blade: wide along b, thin along the hint normal */
async function addBlade(path,wFn,hint,fFn,thick=0.24,sides=10){
  const rings=[],n=path.length;
  for(let i=0;i<n;i++){
    const d=norm(sub(path[Math.min(i+1,n-1)],path[Math.max(i-1,0)]));
    let nn=sub(hint,mul(d,dot(hint,d))); if(vlen(nn)<1e-3)nn=cross(d,[0,0,1]); nn=norm(nn);
    const b=cross(d,nn),t=i/(n-1),w=wFn(t),th=Math.max(thick*w,0.005),ring=[];
    for(let j=0;j<=sides;j++){const ph=j/sides*TAU;
      ring.push({p:add(path[i],add(mul(b,w*Math.cos(ph)),mul(nn,th*Math.sin(ph)))),f:fFn(t,j/sides)});}
    rings.push(ring);
  }
  await addLoft(rings);
}
const curve=(n,fn)=>{const a=[];for(let i=0;i<=n;i++)a.push(fn(i/n));return a;};

/* body: mane-neck → full body → long taper → gold collar → spiral horn-tip */
function bodyBaseR(s){
  const dt=LB*(1-s);
  let r=mix(0.40,0.53,sstep(0,0.05,s));
  r*=mix(1,0.42,sstep(0.36,0.97,s));
  for(const c of GOLD) r+=0.032*Math.exp(-Math.pow((dt-c)/0.03,6));
  return r;
}
const shellPh=(dt,ps)=>{const tr=7.5*Math.pow(clamp(dt/CONE,0,1),0.78);const s=fract(tr-ps/TAU);return sstep(0,0.10,s)*Math.pow(1-s,1.4);};
function bodyR(s,ps){
  const dt=LB*(1-s); let r=bodyBaseR(s);
  if(dt<CONE+0.06){
    const q=clamp(dt/CONE,0,1);
    let rc=0.218*Math.pow(q,0.95)*(0.80+0.20*shellPh(dt,ps));
    rc*=Math.sqrt(clamp(1-Math.pow(1-Math.min(dt/0.05,1),2),0,1));
    r=mix(rc,r,sstep(CONE-0.04,CONE+0.06,dt));
  }
  return Math.max(r,0.0004);
}
{
  const xs=[],FINE=1.9;
  for(let x=0;x>-(LB-FINE);x-=0.03)xs.push(x);
  for(let x=-(LB-FINE);x>-LB;x-=0.0055)xs.push(x);
  xs.push(-LB);
  const M=72,rings=[];let w=0,px=0;
  for(const x of xs){
    const s=-x/LB,dt=LB-(-x),sq=sstep(CONE,CONE+0.25,dt),ring=[];
    const r0=bodyR(s,0);
    w+=(px-x)/Math.max(r0,0.06); px=x;
    for(let j=0;j<=M;j++){const ps=j/M*TAU,c=Math.cos(ps),sn=Math.sin(ps),r=bodyR(s,ps);
      ring.push({p:[x,r*c*mix(1,c<0?0.86:0.98,sq),r*sn*mix(1,1.07,sq)],f:[w,ps,MAT.BODY,lenOf(x)]});}
    rings.push(ring);
    await yieldWithinBudget();
  }
  await addLoft(rings);
}
await yieldForInteraction();
checkCancelled();

/* head — a dragon's head: long snout, heavy brow, closed jaw */
const hW=spline([[-0.3,0.37],[0,0.38],[0.32,0.47],[0.66,0.42],[1.0,0.28],[1.35,0.21],[1.72,0.15]]);
const hT=spline([[-0.3,0.37],[0,0.38],[0.30,0.47],[0.60,0.43],[0.92,0.27],[1.30,0.19],[1.52,0.20],[1.72,0.12]]);
const hB=spline([[-0.3,-0.37],[0,-0.36],[0.30,-0.29],[0.55,-0.07],[0.70,-0.012],[1.72,-0.012]]);
const tipF=x=>Math.sqrt(clamp(1-Math.pow(Math.max(0,(x-1.50)/0.22),2),0,1));
const se=(c,e)=>Math.sign(c)*Math.pow(Math.abs(c),e);
const EX=0.68, EY=0.215, EAX=0.150, EAY=0.096, EAZ=0.045, SDEP=0.05;
function headPt(x,ph){
  const tf=tipF(x);
  const W=hW(x)*tf,B=hB(x),T=mix(B+0.03,hT(x),tf);
  const yc=Math.max(B+0.02,0);
  const c=Math.cos(ph),sn=Math.sin(ph),z=W*se(c,0.8);
  let y=yc+(sn>=0?(T-yc):(yc-B))*se(sn,0.85);
  const zz=Math.abs(z)/Math.max(W,1e-4);
  if(sn>0) y+=0.095*Math.exp(-Math.pow((x-0.62)/0.15,2))*Math.exp(-Math.pow((zz-0.70)/0.25,2))*tf;   // brow ridge
  if(sn>0) y+=0.04*Math.exp(-Math.pow((x-1.50)/0.08,2))*Math.exp(-Math.pow((zz-0.55)/0.3,2));        // nostril
  if(sn>0) y+=0.025*Math.exp(-Math.pow((x-1.05)/0.25,2))*Math.exp(-Math.pow(zz/0.25,2));              // snout ridge
  return [x,y,z,sn];
}
const sockD=(x,y)=>Math.pow((x-EX)/(EAX*1.15),2)+Math.pow((y-EY)/(EAY*1.15),2);
/* conformal length along the head (keeps the bead scales round) + top-surface height */
const headU=(()=>{const N=404,x0=-0.3,dx=(HLm-x0)/N,tab=[0];
  const R=x=>{const tf=tipF(x),B=hB(x);return Math.max(0.5*(hW(x)*tf+0.5*(mix(B+0.03,hT(x),tf)-B)),0.09);};
  for(let i=1;i<=N;i++){const x=x0+(i-0.5)*dx;tab.push(tab[i-1]+HX*dx/(HS*R(x)));}
  const at=x=>{const fq=clamp((x-x0)/dx,0,N),i=Math.min(Math.floor(fq),N-1);return mix(tab[i],tab[i+1],fq-i);};
  const z0=at(0); return x=>at(x)-z0;})();
const surfY=(x,z)=>{const tf=tipF(x),W=hW(x)*tf,B=hB(x),T=mix(B+0.03,hT(x),tf),yc=Math.max(B+0.02,0);
  const c=Math.pow(clamp(Math.abs(z)/Math.max(W,1e-4),0,1),1.25);return yc+(T-yc)*Math.pow(Math.sqrt(1-c*c),0.85);};
let EZ=0;
{ let best=1e9; for(let j=0;j<=4000;j++){const p=headPt(EX,j/4000*Math.PI/2); const d=Math.abs(p[1]-EY); if(d<best){best=d;EZ=Math.abs(p[2]);}if(j%128===0)await yieldWithinBudget();} }
{
  const K=160,M=128,rings=[];
  for(let k=-1;k<=K;k++){
    const x=mix(-0.3,HLm,clamp(k,0,K)/K),ring=[];
    for(let j=0;j<=M;j++){
      const ph=j/M*TAU; let [px,y,z,sn]=k<0?[x,0,0,0]:headPt(x,ph);
      let dark=0;
      if(k>=0){
        const d=sockD(x,y);
        const zr=Math.abs(z)/Math.max(hW(x)*tipF(x),1e-4);
        if(Math.abs(z)>0.15){ z-=Math.sign(z)*SDEP*Math.exp(-d*1.5); dark=Math.max(dark,0.6*Math.exp(-Math.pow((Math.sqrt(d)-0.92)/0.22,2))); }
        if(sn>0){ const e=Math.exp(-1.3*(Math.pow((x-1.57)/0.035,2)+Math.pow((zr-0.74)/0.17,2)));   // nostril pit
          z-=Math.sign(z)*0.022*e; y-=0.012*e; dark=Math.max(dark,e); }
      }
      ring.push({p:hs([x,y,z]),f:[-headU(x),ph-Math.PI/2,MAT.HEAD+0.45*dark,lenOf(x*HX)]});
    }
    rings.push(ring);
    await yieldWithinBudget();
  }
  await addLoft(rings);
}
/* lower jaw (closed) */
const jB=spline([[0.35,-0.31],[0.8,-0.27],[1.2,-0.18],[1.62,-0.09]]);
const jawW=x=>0.985*hW(x)*Math.sqrt(clamp(1-Math.pow(Math.max(0,(x-1.38)/0.26),2),0,1));
{
  const K=64,M=64,rings=[];
  for(let k=-1;k<=K+1;k++){
    const x=mix(0.35,1.62,clamp(k,0,K)/K),ring=[],cap=(k<0||k>K);
    const W=cap?0.001:Math.max(jawW(x),0.001),yT=-0.004,yc=yT-0.02,yB=cap?yc-0.001:jB(x);
    for(let j=0;j<=M;j++){
      const ph=j/M*TAU,c=Math.cos(ph),sn=Math.sin(ph);
      const y=yc+(sn>=0?(cap?0.001:(yT-yc)):(yc-yB))*se(sn,0.85);
      ring.push({p:hs([x,y,W*se(c,0.8)]),f:[-headU(x),ph-Math.PI/2,MAT.HEAD,lenOf(x*HX)]});
    }
    rings.push(ring);
    await yieldWithinBudget();
  }
  await addLoft(rings);
}
/* eyes: a flattened lens set into the socket */
for(const side of [-1,1]){
  const c=[EX,EY,(EZ-SDEP+0.004)*side],rings=[];
  for(let k=0;k<=16;k++){const al=k/16*Math.PI,ring=[];
    for(let j=0;j<=28;j++){const be=j/28*TAU,n=[Math.sin(al)*Math.cos(be),Math.sin(al)*Math.sin(be),Math.cos(al)];
      ring.push({p:hs(add(c,[n[0]*EAX,n[1]*EAY,n[2]*EAZ*side])),f:[n[0],n[1],MAT.EYE,lenOf(EX*HX)]});}
    rings.push(ring);await yieldWithinBudget();}
  await addLoft(rings);
}
/* forehead sapphire: a faceted kite-cut gem set on the brow (facets are flat-shaded in the fragment shader) */
{
  const us=[0,0.19,0.38,0.69,1],hx=[0,0.82,1,0.80,0],vs=[-1,-0.5,0,0.5,1],hv=[0,0.78,1,0.78,0],rings=[];
  us.forEach((u,i)=>{const x=0.50+0.54*u,w=0.105*Math.min(u/0.38,(1-u)/0.62),ring=[];
    for(let j=0;j<5;j++){const z=vs[j]*w;
      ring.push({p:hs([x,surfY(x,z)-0.014+(0.075*hv[j]+0.012)*hx[i],z]),f:[u,vs[j],MAT.GEM,lenOf(x*HX)]});}
    rings.push(ring);});
  await addLoft(rings);
}
/* antler-horns (champagne gold): a long S-curved main beam with a fork, a brow horn, and a crown of gold spurs round the gem */
for(const side of [-1,1]){
  const un=p=>[p[0]/HX,p[1]/HS,p[2]/HS];
  const main=t=>hs([0.32-2.40*t, 0.36+0.98*t-0.86*t*t+0.62*Math.pow(t,3.5), side*(0.19+0.36*t+0.07*Math.sin(Math.PI*t))]);
  await addTube(curve(34,main),t=>(0.098*Math.pow(1-t,0.74)+0.004)*HS,12,t=>[t,0,MAT.HORN,lenOf(0.3)]);
  const b=un(main(0.50));
  await addTube(curve(14,t=>hs([b[0]-0.70*t,b[1]+0.24*t+0.18*t*t,b[2]+side*0.10*t])),t=>(0.052*Math.pow(1-t,0.8)+0.003)*HS,8,t=>[0.45+0.55*t,0,MAT.HORN,lenOf(0.2)]);
  const b2=un(main(0.24));
  await addTube(curve(10,t=>hs([b2[0]-0.40*t,b2[1]+0.20*t+0.06*t*t,b2[2]+side*0.06*t])),t=>(0.036*Math.pow(1-t,0.8)+0.003)*HS,8,t=>[0.5+0.5*t,0,MAT.HORN,lenOf(0.2)]);
  await addTube(curve(16,t=>hs([0.50-1.00*t,0.39+0.58*t-0.20*t*t+0.16*t*t*t,side*(0.25+0.26*t)])),t=>(0.056*Math.pow(1-t,0.8)+0.003)*HS,8,t=>[0.25+0.75*t,0,MAT.HORN,lenOf(0.4)]);
  for(let k=0;k<4;k++){
    const bx=0.50+0.13*k,bz=0.205-0.022*k,L=0.44-0.07*k,by=surfY(bx,bz)-0.012;
    await addTube(curve(8,t=>hs([bx-0.62*L*t-0.34*L*t*t,by+0.66*L*t-0.14*L*t*t,side*(bz+0.20*L*t)])),t=>(0.026*Math.pow(1-t,0.9)+0.0025)*HS,6,t=>[0.6+0.4*t,0,MAT.HORN,lenOf(bx*HX)]);
  }
}
/* mane: layered pearl feather-plumes sweeping back from the cheeks and skull + a feathered crest down the neck */
{
  const plume=async (pts,W,hint,len,thick)=>addBlade(pts,t=>W*(0.42+0.58*sstep(0,0.26,t))*Math.pow(1-t,0.85)+0.003,hint,(t,v)=>[t,v,MAT.SPIKE,len],thick);
  const ROW=[[0.26,0.44,7,0.78],[0.05,0.42,8,1.02],[-0.20,0.40,8,1.22]];
  for(const side of [-1,1]){
    for(const [rowIndex,[x0,rad,n,Lr]] of ROW.entries()){
      for(let k=0;k<n;k++){
        const a=-1.05+(k+(rowIndex%2)*0.5)/n*2.30;
        const L=Lr*(0.82+0.26*Math.sin(k*1.9+rowIndex*1.3+0.6))*(1-0.22*Math.abs(a-0.4));
        const base=[x0,0.03+(a<0?0.30:0.38)*Math.sin(a),side*rad*Math.cos(a)*0.96];
        const dir=norm([-1,0.24*Math.sin(a)+0.10,side*0.30*Math.cos(a)]);
        const wv=0.05*Math.sin(k*2.3+rowIndex);
        await plume(curve(10,t=>hs(add(add(base,mul(dir,L*t)),[-0.10*t*t,(0.10+0.10*Math.sin(a))*L*t*t,side*wv*t*t]))),
          (0.125+0.04*L)*HS,[0.25,Math.sin(a),side*Math.cos(a)],lenOf(x0*HX));
      }
      await yieldWithinBudget();
    }
    /* ear plume */
    await plume(curve(10,t=>hs([0.14-0.80*t,0.18+0.08*t+0.16*t*t,side*(0.40+0.40*t-0.10*t*t)])),0.15*HS,[0,0.5,side],lenOf(0.1));
    /* chin tufts */
    for(let k=0;k<2;k++)
      await plume(curve(8,t=>hs([0.50-0.25*k-(0.42+0.10*k)*t,-0.24-0.14*t-0.05*t*t,side*(0.30+0.14*t)])),0.085*HS,[0,-1,side*0.5],lenOf(0.3));
  }
  for(let i=0;i<12;i++){
    const x=-0.10-i*0.34, r=bodyBaseR(-x/LB), L=0.66*(1-i/15)*(i%2?0.8:1);
    await plume(curve(8,t=>[x-0.78*L*t-0.10*t*t,r*0.92+0.64*L*t,0]),0.10*(1-i/20),[0,0,1],lenOf(x),0.5);
    if(i<8)for(const side of [-1,1]){
      const L2=0.42*(1-i/10);
      await plume(curve(6,t=>[x-0.15-0.80*L2*t,r*0.78+0.40*L2*t,side*(r*0.62+0.36*L2*t)]),0.07,[0,0.6,side*0.8],lenOf(x),0.4);
    }
  }
}
/* whiskers & silk filaments — animated in the vertex shader */
{
  let sd=0;
  for(const side of [-1,1]){
    const s0=(sd++)*0.37+side;
    await addTube(curve(36,t=>hs([1.58+0.80*t-0.95*t*t,-0.03-0.42*t+0.20*t*t+0.10*Math.sin(t*5.6)*t,side*(0.13+0.38*t+0.30*t*t)])),
      t=>(0.026*Math.pow(1-t,0.8)+0.004)*HS,6,t=>[t,s0,MAT.WHISK,lenOf(1.4)]);
    for(let k=0;k<3;k++){
      const y0=0.30+k*0.05,z0=0.30+k*0.04,len=2.1+k*0.35;
      const s1=(sd++)*0.53+side*0.5;
      await addTube(curve(30,t=>hs([0.62-k*0.10-len*t,y0+(0.30-k*0.12)*t-0.18*t*t,side*(z0+0.30*t+0.12*k*t)])),
        t=>(0.013*(1-t)+0.0025)*HS,5,t=>[t,s1,MAT.WHISK,lenOf(0.6)]);
    }
  }
}
const snakeGeo=new L3.Geometry();
snakeGeo.setAttribute('position',new Float32Array(G.pos),3);
snakeGeo.setAttribute('normal',new Float32Array(G.nor),3);
snakeGeo.setAttribute('aInfo',new Float32Array(G.inf),4);
snakeGeo.setIndex(new Uint32Array(G.idx));

/* ------------------------------------------------------------------ */
/*  Shaders                                                            */
/* ------------------------------------------------------------------ */
const SIGK=0.6, WY=-7.0, SIGZ=-2.0, RHALO=6.45, STAR=[0,RHALO,SIGZ], CORE=[0,0,SIGZ];
const f=x=>x.toFixed(6);
const CONSTS=`
#define CIRC ${f(CIRC)}
#define LBODY ${f(LB)}
#define HLEN ${f(HL)}
#define TOTAL ${f(TOTAL)}
#define CONE ${f(CONE)}
#define WATERY ${f(WY)}
#define HXC ${f(HX)}
`;
const PATH=CONSTS+/*glsl*/`
uniform float uTime; uniform float uSpin;
uniform vec3 uFC[${KF}]; uniform vec3 uFS[${KF}];
void pathFrame(float u,out vec3 C,out vec3 T,out vec3 D,out vec3 S){
  vec3 c=uFC[0]; vec3 d=vec3(0.0);
  float c1=cos(u), s1=sin(u), ck=1.0, sk=0.0;
  for(int k=1;k<${KF};k++){
    float nc=ck*c1-sk*s1; sk=sk*c1+ck*s1; ck=nc; float fk=float(k);
    c+=uFC[k]*ck+uFS[k]*sk; d+=fk*(uFS[k]*ck-uFC[k]*sk);
  }
  float t=uTime*0.35;
  c.z+=0.10*sin(2.0*u-t)+0.05*sin(4.0*u+t*1.3);
  d.z+=0.20*cos(2.0*u-t)+0.20*cos(4.0*u+t*1.3);
  float b=1.0+0.012*sin(uTime*0.6);
  c.xy*=b; d.xy*=b;
  C=c; T=normalize(d); D=normalize(cross(vec3(0.0,0.0,1.0),T)); S=cross(T,D);
}
/* roll that keeps the head upright, fading out down the neck */
float rollW(float len){ float xb=HLEN-len*TOTAL; return smoothstep(-3.8,-0.2,xb); }`;

const TRACK=/*glsl*/`
#define NE ${NE}
uniform vec3 uE[NE]; uniform vec3 uEG; uniform float uEStep; uniform float uHead; uniform float uJoin; uniform vec3 uJC;
void entryFrame(float d,out vec3 C,out vec3 T){
  float Lm=uEStep*float(NE-1);
  float f=clamp(d,0.0,Lm-1e-3)/uEStep; int i=int(floor(f)); float t=f-float(i);
  vec3 p1=uE[i]; vec3 p2=uE[min(i+1,NE-1)];
  vec3 p0=i>0?uE[max(i-1,0)]:uEG;
  vec3 p3=i+2<NE?uE[min(i+2,NE-1)]:2.0*p2-p1;
  vec3 A=2.0*p1, B=p2-p0, Cc=2.0*p0-5.0*p1+4.0*p2-p3, Dd=-p0+3.0*p1-3.0*p2+p3;
  C=0.5*(A+B*t+Cc*t*t+Dd*t*t*t);
  T=-normalize(0.5*(B+2.0*Cc*t+3.0*Dd*t*t)+vec3(1e-6));
  if(d>Lm) C-=T*(d-Lm);
}
/* x = arc coordinate in path space (head tip = +HLEN). Ahead of the join → loop; behind it → entry spiral */
void trackFrame(float x,out vec3 C,out vec3 T,out vec3 D,out vec3 S){
  float a=x+uHead;
  if(a>=0.0){ pathFrame(uJoin+a*(6.2831853/CIRC),C,T,D,S); return; }
  float d=-a; entryFrame(d,C,T);
  /* 与 pathFrame 完全相同的呼吸 + 波动，向后平滑衰减（d=0 处导数为 0）→ 并入点位置、方向都连续 */
  float b=1.0+0.012*sin(uTime*0.6); C.xy*=b;
  float ue=uJoin-d*(6.2831853/CIRC), tt=uTime*0.35;
  C.z+=(0.10*sin(2.0*ue-tt)+0.05*sin(4.0*ue+tt*1.3))*exp(-d*d/40.0);
  D=normalize(cross(vec3(0.0,0.0,1.0),T)); S=cross(T,D);
}`;

/* day sky (pale, luminous) + night environment (for reflections) */
const SKY=/*glsl*/`
uniform vec3 uSunDir; uniform vec3 uCoreDir; uniform float uNight;
vec3 skyBase(vec3 rd){
  float sy=rd.y; float y=abs(sy);
  vec3 hor=vec3(0.80,0.865,0.965), mid=vec3(0.57,0.69,0.925), zen=vec3(0.38,0.51,0.84);
  vec3 c=mix(hor,mid,smoothstep(0.0,0.22,y)); c=mix(c,zen,smoothstep(0.18,0.85,y));
  c+=vec3(0.06,0.06,0.05)*exp(-y*22.0)*0.5;
  float sg=max(dot(vec3(rd.x,y,rd.z),uSunDir),0.0);
  c+=vec3(0.92,0.96,1.0)*(pow(sg,400.0)*0.6+pow(sg,40.0)*0.06+pow(sg,6.0)*0.025);
  c*=mix(vec3(1.0),vec3(0.84,0.89,0.98),smoothstep(0.0,0.30,-sy));
  return c;
}
vec3 nightEnv(vec3 rd){
  float y=abs(rd.y);
  vec3 c=mix(vec3(0.03,0.05,0.11),vec3(0.006,0.010,0.028),smoothstep(0.0,0.8,y));
  float sg=max(dot(rd,uCoreDir),0.0);
  c+=vec3(1.0,0.62,0.28)*(pow(sg,14.0)*0.9+pow(sg,3.0)*0.08);
  c+=vec3(0.25,0.45,1.0)*pow(max(-rd.x*0.6+rd.y*0.5,0.0),3.0)*0.15;
  return c;
}
vec3 envSky(vec3 rd){return mix(skyBase(rd),nightEnv(rd),uNight);}`;

const snakeVS=PATH+TRACK+/*glsl*/`
attribute vec4 aInfo;
uniform float uMirror; uniform float uRoll;
varying vec3 vW; varying vec3 vN; varying vec4 vInfo; varying vec3 vTx; varying vec3 vTy;
void main(){
  vec3 p=position; vec3 nm=normal;
  float m=aInfo.z;
  if(m>5.5&&m<6.5){                       /* whiskers drift like silk under water */
    float t=aInfo.x, sd=aInfo.y, a=t*t;
    p.y+=(sin(uTime*1.25+sd*6.1-t*3.4)*0.15+sin(uTime*2.1+sd*2.3-t*6.0)*0.04)*a;
    p.z+=cos(uTime*0.95+sd*4.3-t*2.8)*0.12*a;
    p.x+=sin(uTime*0.8+sd*3.0-t*2.0)*0.07*a;
  }
  float ra=uRoll*rollW(aInfo.w), cr=cos(ra), sr=sin(ra);
  p.yz=vec2(p.y*cr-p.z*sr,p.y*sr+p.z*cr);
  nm.yz=vec2(nm.y*cr-nm.z*sr,nm.y*sr+nm.z*cr);
  vec3 C,T,D,S; trackFrame(p.x,C,T,D,S);
  float br=1.0+0.025*sin(uTime*1.3-aInfo.w*18.85)*max(step(m,5.5),step(7.5,m));
  vec3 wp=C+(D*p.y+S*p.z)*br;
  vW=wp; vN=normalize(T*nm.x+D*nm.y+S*nm.z); vInfo=aInfo; vTx=T; vTy=D*cr+S*sr;
  if(uMirror>0.5) wp.y=2.0*WATERY-wp.y;
  gl_Position=projectionMatrix*viewMatrix*vec4(wp,1.0);
}`;

const snakeFS=CONSTS+SKY+/*glsl*/`
uniform float uTime; uniform vec3 uPointer; uniform float uPointerI; uniform float uMirror;
uniform float uPulsePos; uniform float uPulseAmp; uniform float uCore; uniform vec3 uLightPos;
varying vec3 vW; varying vec3 vN; varying vec4 vInfo; varying vec3 vTx; varying vec3 vTy;
float hash21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
vec3 pal(float t){return 0.5+0.5*cos(6.28318*(t+vec3(0.0,0.33,0.67)));}
void scaleField(vec2 p,out float edge,out vec2 grad,out float id,out float lx,out vec2 cc){
  float best=-1e5; edge=1.0; grad=vec2(0.0); id=0.0; lx=0.0; cc=vec2(0.0);
  for(int l=0;l<2;l++){
    vec2 off=vec2(float(l)*0.5);
    vec2 c0=floor(p-off+0.5)+off;
    for(int i=-1;i<=1;i++){
      vec2 c=c0+vec2(float(i),0.0);
      vec2 d=(p-c)*vec2(0.80,1.0);
      float r2=dot(d,d)/0.4356;
      if(r2<1.0){
        float h=0.9*(p.x-c.x)+0.35*(1.0-r2*r2);
        if(h>best){
          best=h; edge=r2; lx=p.x-c.x; cc=c;
          grad=vec2(0.9-1.4*r2*d.x*0.80/0.4356,-1.4*r2*d.y/0.4356);
          id=hash21(vec2(c.x,mod(c.y,40.0))+7.31);
        }
      }
    }
  }
}
/* head: round pearl bead-scales */
void beadField(vec2 p,out float edge,out vec2 grad,out float id,out float lx,out vec2 cc){
  float best=1e5; edge=1.0; grad=vec2(0.0); id=0.0; lx=0.0; cc=vec2(0.0);
  for(int l=0;l<2;l++){
    vec2 off=vec2(float(l)*0.5);
    vec2 c=floor(p-off+0.5)+off; vec2 d=p-c; float r2=dot(d,d);
    if(r2<best){
      best=r2; cc=c; lx=d.x; float q=r2/0.1369;
      edge=min(q,1.0); grad=q<1.0?d*(-5.1):vec2(0.0);
      id=hash21(vec2(c.x,mod(c.y,16.0))+3.17);
    }
  }
}
vec3 lit(vec3 N,vec3 V,vec3 P,vec3 alb,vec3 sc,float shin){
  float n=uNight;
  vec3 hemi=mix(mix(vec3(0.42,0.52,0.78),vec3(0.80,0.87,1.0),N.y*0.5+0.5),
                mix(vec3(0.010,0.016,0.035),vec3(0.05,0.08,0.16),N.y*0.5+0.5),n);
  vec3 col=alb*hemi*mix(0.66,0.62,n);
  vec3 Ls[4]; vec3 Cs[4];
  Ls[0]=normalize(mix(vec3(-0.35,0.80,0.55),vec3(-0.5,0.7,0.6),n)); Cs[0]=mix(vec3(1.0,0.985,0.96)*0.90,vec3(0.55,0.68,1.0)*0.75,n);
  Ls[1]=normalize(vec3(0.45,0.25,-0.85)); Cs[1]=mix(vec3(0.75,0.86,1.0)*0.75,vec3(0.25,0.50,1.0)*1.3,n);
  vec3 d=uLightPos-P; float dd=dot(d,d);
  Ls[2]=d*inversesqrt(dd); Cs[2]=mix(vec3(0.96,0.98,1.0)*1.2/(1.0+0.04*dd),vec3(1.0,0.66,0.34)*1.6/(1.0+0.6*dd),n)*uCore;
  d=uPointer-P; dd=dot(d,d);
  Ls[3]=d*inversesqrt(dd+1e-4); Cs[3]=mix(vec3(0.75,0.90,1.0),vec3(0.65,0.88,1.0),n)*uPointerI*3.0/(0.35+dd);
  for(int i=0;i<4;i++){
    float ndl=max((dot(N,Ls[i])+0.35)/1.35,0.0);
    vec3 H=normalize(Ls[i]+V+vec3(1e-4));
    float sp=pow(max(dot(N,H),0.0),shin)*(shin+8.0)*0.035;
    col+=Cs[i]*(alb*ndl+sc*sp*max(dot(N,Ls[i]),0.0));
  }
  float ndv=max(dot(N,V),0.0);
  float F=pow(1.0-ndv,5.0);
  col+=envSky(reflect(-V,N))*sc*(0.04+0.96*F)*0.65;
  return col;
}
vec3 goldShade(vec3 N,vec3 V,vec3 gold){
  float n=uNight; float ndv=max(dot(N,V),0.0);
  vec3 R=reflect(-V,N);
  float le=dot(envSky(R),vec3(0.30,0.50,0.20));
  vec3 Lk=normalize(vec3(-0.35,0.80,0.55)); vec3 H=normalize(Lk+V+vec3(1e-4));
  float sp=pow(max(dot(N,H),0.0),150.0)*7.0;
  float sp2=pow(max(dot(N,normalize(normalize(uLightPos-vW)+V+vec3(1e-4))),0.0),110.0)*mix(5.0,2.5,n)*uCore;
  float band=0.55+0.45*smoothstep(-0.2,0.6,R.y);
  vec3 col=gold*(0.06+mix(0.95,0.9,n)*le*(0.35+0.9*band*band)+mix(0.40,0.30,n)*max(dot(N,Lk),0.0));
  col+=mix(gold,vec3(1.0,0.95,0.82),0.6)*(sp+sp2);
  col+=gold*pow(1.0-ndv,3.0)*1.1;
  return col;
}
void main(){
  float mat=vInfo.z; float len=vInfo.w; float n=uNight;
  vec3 cam=uMirror>0.5?vec3(cameraPosition.x,2.0*WATERY-cameraPosition.y,cameraPosition.z):cameraPosition;
  vec3 dpx=dFdx(vW), dpy=dFdy(vW);
  vec2 dix=dFdx(vInfo.xy), diy=dFdy(vInfo.xy);
  vec3 N=normalize(vN); vec3 V=normalize(cam-vW);
  if(dot(N,V)<0.0) N=-N;
  float wave=pow(0.5+0.5*sin(len*25.13-uTime*1.2),8.0);
  float dp=abs(fract(len-uPulsePos+0.5)-0.5);
  float click=uPulseAmp*exp(-dp*dp/0.0016);
  float dt=LBODY-(len*TOTAL-HLEN);
  vec3 goldT=mix(vec3(1.0,0.74,0.36),vec3(1.0,0.50,0.10),n);
  if(mat<0.5){
    if(dt<CONE) mat=4.0;
    else if(min(min(abs(dt-CONE-0.07),abs(dt-CONE-0.18)),abs(dt-CONE-0.29))<0.03) mat=3.0;
  }
  vec3 col;
  if(mat<1.5){
    /* ---------- scales: pearl + sapphire diamond band + gold filigree ---------- */
    float isHead=step(0.5,mat);
    float darkK=clamp((mat-1.0)/0.45,0.0,1.0)*isHead;
    float NS=mix(19.0,16.0,isHead);
    vec2 p=vInfo.xy*(NS/6.28318);
    float edge; vec2 g; float id; float lx; vec2 cc;
    if(isHead>0.5) beadField(p+vec2(0.0,0.25),edge,g,id,lx,cc); else scaleField(p,edge,g,id,lx,cc);
    float ks=NS/6.28318;
    float hx=dot(g,dix*ks), hy=dot(g,diy*ks);
    vec3 r1=cross(dpy,N), r2=cross(N,dpx); float det=dot(dpx,r1);
    vec3 sg=sign(det)*(hx*r1+hy*r2);
    vec3 nb=abs(det)*N-sg*mix(0.05,0.034,isHead);
    float nl=dot(nb,nb);
    if(nl>1e-20 && abs(det)>1e-12) N=nb*inversesqrt(nl);
    float psi=vInfo.y; float cps=cos(psi); float lat=abs(sin(psi));
    float belly=(1.0-smoothstep(-0.97,-0.80,cps))*(1.0-isHead);
    float cy=mod(cc.y+NS*0.5,NS)-NS*0.5;
    float psiC=cy*6.28318/NS;
    float latC=abs(sin(psiC));
    /* the band edge zig-zags → a chain of diamonds along each flank */
    /* continuous zig-zag edge → a chain of diamonds; scales inside stay gem-cut */
    float tri=abs(fract(p.x/10.0+step(0.0,sin(psi))*0.5)-0.5)*2.0;
    float thr=mix(0.70,0.965,tri);
    float fwl=fwidth(lat)+1e-4;
    float band=smoothstep(thr-fwl,thr+fwl,lat)*step(-0.40,cps)*(1.0-isHead);
    vec2 gq=vec2(cc.x+cy,cc.x-cy)/5.0;
    vec2 lg=fract(gq)-0.5; float m=max(abs(lg.x),abs(lg.y))*2.0;
    float chk=mod(floor(gq.x)+floor(gq.y),2.0);
    vec3 deep=vec3(0.004,0.040,0.40), midB=vec3(0.020,0.17,0.84), lite=vec3(0.30,0.62,1.0);
    /* each sapphire scale is a little gem: lit centre, deep rim */
    float gem=smoothstep(0.9,0.1,edge)*smoothstep(-0.6,0.3,lx);
    vec3 blue=mix(deep,midB,0.40+0.60*gem)*(0.88+0.24*id);
    blue=mix(blue,lite,gem*gem*0.45*(1.0-0.6*chk));
    blue=mix(blue,deep,chk*0.35);
    vec3 white=vec3(0.90,0.93,1.0)*(0.95+0.05*id);
    vec3 alb=mix(white,blue,band);
    /* crevices between the pearl scales read as cool blue lines */
    alb=mix(alb,alb*vec3(0.55,0.68,0.98),smoothstep(0.62,1.0,edge)*(1.0-band)*0.8);
    /* head accents: a sapphire line between the eyes, blue tint along the snout */
    /* crown: sapphire cells in a gold net (cloisonné) round the forehead gem, tapering to a point on the snout */
    float xm=(HLEN-len*TOTAL)/HXC;
    float topS=step(0.0,cps)*isHead;
    float Wh=mix(mix(0.38,0.47,smoothstep(-0.1,0.32,xm)),0.24,smoothstep(0.45,1.25,xm));
    float zc=pow(lat,0.8)*Wh; float fz=fwidth(zc)+1e-4;
    float gu=(xm-0.50)/0.54; float gk=0.105*min(gu/0.38,(1.0-gu)/0.62);
    float cwid=mix(0.32,0.23,smoothstep(-0.3,0.5,xm))*(1.0-smoothstep(0.50,1.05,xm));
    float crE=max(cwid-0.02,gk+0.055);
    float crown=topS*(1.0-smoothstep(crE-fz,crE+fz,zc));
    vec3 sapph=mix(deep,midB,0.20+0.60*gem)*(0.85+0.25*id);
    sapph=mix(sapph,lite,gem*gem*0.22);
    alb=mix(alb,sapph,crown);
    alb=mix(alb,vec3(0.04,0.20,0.85),darkK*0.7);                   /* blue shadow round the eye */
    float hgold=topS*(1.0-smoothstep(0.011,0.011+fz,abs(zc-crE)));
    hgold=max(hgold,topS*(1.0-smoothstep(0.010,0.010+fz,abs(zc-gk-0.018))));   /* bezel of the gem */
    hgold=max(hgold,crown*smoothstep(0.88,0.985,edge)*0.9);
    float lip=isHead*smoothstep(0.988,0.999,lat)*smoothstep(0.55,0.72,xm);     /* mouth line */
    /* the flank band flows up the neck onto the cheek and thins out under the eye */
    float thH=mix(0.90,0.997,smoothstep(-0.3,0.95,xm));
    float hbd=isHead*smoothstep(thH-0.012,thH+0.012,lat)*step(-0.20,cps)*(1.0-smoothstep(0.95,1.15,xm));
    vec3 hblue=mix(deep,midB,0.45+0.55*gem)*(0.9+0.2*id);
    alb=mix(alb,hblue,hbd);
    float hgl=isHead*(1.0-smoothstep(0.0,0.010+fwidth(lat),abs(lat-thH+0.022)))*step(-0.20,cps)*(1.0-smoothstep(0.85,1.1,xm));
    hgl=max(hgl,hgold);
    alb=mix(alb,vec3(0.70,0.80,1.0),isHead*smoothstep(0.2,0.9,cps)*0.25*(1.0-crown));
    alb=mix(alb,vec3(0.95,0.96,1.0),belly);
    float ao=1.0-0.36*smoothstep(0.55,1.0,edge);
    ao*=mix(0.74,1.0,smoothstep(-0.55,0.35,lx));
    ao*=(1.0-0.35*darkK-0.55*smoothstep(0.65,1.0,darkK))*(1.0-0.55*lip);
    float bandS=max(band,crown);
    float ndv=max(dot(N,V),0.0);
    vec3 sc=mix(vec3(0.95,0.97,1.0),pal(ndv*0.7+id*0.2+0.55),0.20);
    col=lit(N,V,vW,alb*ao,sc*ao*mix(1.0,1.35,bandS),mix(70.0,120.0,bandS));
    /* pearly translucency at grazing angles */
    col+=mix(vec3(0.62,0.78,1.0),vec3(0.10,0.38,1.0),max(bandS,n*0.6))*pow(1.0-ndv,2.2)*mix(0.50,0.30,n)*(1.0-darkK)*(1.0-0.6*crown);
    col+=(pal(ndv*1.3+vInfo.x*0.004+0.1)-0.5)*0.07*(1.0-band)*(1.0-n)*(1.0-darkK);
    /* sapphire sparkle inside the band */
    float tw=pow(0.5+0.5*sin(uTime*(1.5+id*3.0)+id*60.0),24.0);
    col+=vec3(0.45,0.80,1.0)*bandS*step(0.80,id)*tw*(1.0-edge)*mix(1.6,2.6,n);
    float rim=smoothstep(0.82,1.0,edge);
    col+=mix(vec3(0.90,0.95,1.0),vec3(0.35,0.70,1.0),n)*rim*(0.04+0.10*n+0.40*wave+3.0*click)*(1.0-darkK);
    col+=vec3(0.10,0.40,1.0)*band*n*(0.10+0.25*wave);
    col+=vec3(0.75,0.88,1.0)*click*0.45*(1.0-edge);
    if(hgl>0.001){vec3 Ng=normalize(vN); if(dot(Ng,V)<0.0) Ng=-Ng; col=mix(col,goldShade(Ng,V,goldT)*(1.0+3.0*click),hgl*0.9);}
    /* gold filigree: a loose diamond net over the band + long wandering wires */
    if(isHead<0.5){
      float wob=0.9*sin(p.x*0.17+psi*1.7)+0.5*sin(p.x*0.061+1.3);
      float q1=abs(fract((p.x+p.y*1.4+wob)/7.0)-0.5)*7.0, q2=abs(fract((p.x-p.y*1.4-wob)/7.0)-0.5)*7.0;
      float dn=min(q1,q2)*0.58;
      float fw=max(fwidth(p.x),fwidth(p.y))*0.75+1e-4;
      float net=(1.0-smoothstep(0.05,0.05+fw,dn))*smoothstep(0.55,0.80,lat)*step(-0.45,cps);
      float h1=abs(fract(p.x/34.0+psi/6.28318+0.06*sin(p.x*0.05))-0.5)*34.0;
      float h2=abs(fract(p.x/29.0-psi/6.28318+0.31+0.05*sin(p.x*0.043+2.0))-0.5)*29.0;
      float wire=(1.0-smoothstep(0.065,0.065+fw,min(h1,h2)))*(1.0-belly);
      float gcov=clamp(max(net,wire*0.95),0.0,1.0)*smoothstep(0.0,0.4,dt-CONE-0.4);
      if(gcov>0.001){
        vec3 Ng=normalize(vN); if(dot(Ng,V)<0.0) Ng=-Ng;
        vec3 gc=goldShade(Ng,V,goldT)*(1.0+0.6*wave+3.0*click);
        col=mix(col,gc,gcov);
      }
    }
  }else if(mat<2.5){
    /* antler-horns: polished champagne gold with growth rings near the base */
    float t=vInfo.x;
    float rings=1.0-0.22*smoothstep(0.55,1.0,sin(t*95.0))*(1.0-smoothstep(0.50,0.90,t));
    vec3 tint=mix(vec3(1.0,0.86,0.62),goldT,smoothstep(0.0,0.8,t));
    col=goldShade(N,V,tint)*rings;
    col+=goldT*smoothstep(0.85,1.0,t)*(0.15+0.4*n+0.6*wave+4.0*click);
  }else if(mat<3.5){
    col=goldShade(N,V,goldT);
    col+=goldT*(0.03+0.08*n+0.5*wave+3.0*click);
  }else if(mat<4.5){
    /* spiral horn-tip of the tail: nacre whorls */
    float ndv=max(dot(N,V),0.0);
    float tr=7.5*pow(clamp(dt/CONE,0.0,1.0),0.78);
    float s=fract(tr-vInfo.y/6.28318);
    float ridge=smoothstep(0.0,0.10,s)*pow(1.0-s,1.4);
    vec3 alb=mix(vec3(0.62,0.74,0.98),vec3(0.95,0.97,1.0),ridge);
    alb=mix(alb,vec3(0.35,0.58,1.0),(1.0-smoothstep(0.0,0.5,dt/CONE))*0.4);
    col=lit(N,V,vW,alb,vec3(1.0),110.0);
    col+=(pal(ndv*1.5+s*0.3)-0.5)*0.10*(1.0-n);
    col+=mix(vec3(0.60,0.80,1.0),vec3(0.30,0.62,1.0),n)*(pow(1.0-ndv,2.0)*0.55+0.03+0.14*n+3.0*click)*(0.55+0.45*ridge);
    col+=vec3(0.55,0.82,1.0)*(1.0-smoothstep(0.0,0.12,dt))*(0.6+1.4*n);
  }else if(mat<5.5){
    /* recessed eye: glowing sapphire iris, vertical slit pupil, parallax */
    vec2 uv=vInfo.xy;
    float vn=max(abs(dot(V,N)),0.35);
    vec2 vt=vec2(dot(V,vTx),dot(V,vTy));
    vec2 q=(uv-vt/vn*0.22)/0.78;
    float r=length(q);
    float ang=atan(q.y,q.x);
    float fib=0.80+0.20*sin(ang*46.0+sin(ang*7.0)*2.0)*smoothstep(0.15,0.9,r);
    vec3 iris=mix(vec3(0.85,0.98,1.0),vec3(0.04,0.38,1.0),smoothstep(0.05,0.85,r))*fib;
    iris=mix(iris,vec3(0.02,0.05,0.16),smoothstep(0.90,1.0,r));
    float ir=(r-0.38)/0.12; iris+=vec3(0.55,0.88,1.0)*exp(-ir*ir)*0.45;
    float w=0.19*sqrt(max(1.0-q.y*q.y/0.85,0.0))+0.02;
    float pupil=1.0-smoothstep(w-0.02,w+0.02,abs(q.x));
    float lid=smoothstep(0.62,0.95,length(uv));
    vec3 alb=iris*(1.0-pupil*0.96);
    col=alb*(mix(1.9,2.2,n)+5.0*click)*(1.0-pupil);
    col+=alb*pupil*0.05;
    col*=1.0-0.35*lid;
    col+=lit(N,V,vW,vec3(0.0),vec3(1.0),420.0)*1.6;
    col+=envSky(reflect(-V,N))*pow(1.0-vn,3.0)*0.6;
  }else if(mat<6.5){
    /* silk whiskers: pale gold threads */
    float t=vInfo.x; float ndv=max(dot(N,V),0.0);
    vec3 tint=mix(vec3(0.66,0.64,0.93),vec3(0.90,0.92,1.0),t*0.5);
    col=goldShade(N,V,tint)*0.85+tint*(0.22+0.3*n)*(1.0-t*0.5)+vec3(0.6,0.8,1.0)*(wave*0.4+3.0*click);
  }else if(mat<7.5){
    /* mane plumes: pearl feathers — a bright rib, fine barbs, lavender-blue at the root, light at the tips */
    float t=vInfo.x; float ndv=max(dot(N,V),0.0);
    float xw=cos(vInfo.y*6.28318);
    float rib=1.0-smoothstep(0.04,0.13,abs(xw));
    float barb=0.5+0.5*sin(6.28318*(t*24.0-abs(xw)*1.7));
    vec3 alb=mix(vec3(0.50,0.62,0.98),vec3(0.93,0.95,1.0),smoothstep(0.0,0.40,t));
    alb*=mix(0.80,1.0,smoothstep(0.10,0.60,barb));
    alb=mix(alb,vec3(0.98,0.985,1.0),rib*0.8);
    alb=mix(alb,vec3(0.70,0.78,1.0),smoothstep(0.75,1.0,abs(xw))*0.35);
    col=lit(N,V,vW,alb*0.92,vec3(1.0),90.0);
    col+=mix(vec3(0.70,0.85,1.0),vec3(0.30,0.60,1.0),n)*(pow(1.0-ndv,2.0)*0.40+smoothstep(0.6,1.0,t)*(0.14+0.35*n+0.5*wave+3.0*click));
  }else{
    /* forehead sapphire: flat facets, inner glow, sky reflections */
    vec3 Nf=normalize(cross(dpx,dpy)); if(dot(Nf,V)<0.0) Nf=-Nf;
    float ndv=max(dot(Nf,V),0.0);
    float fac=0.5+0.5*sin(dot(Nf,vec3(7.0,11.0,5.0))*9.0);
    vec3 base=mix(vec3(0.01,0.10,0.78),vec3(0.08,0.50,1.0),fac);
    col=base*(0.70+0.9*n)+lit(Nf,V,vW,base*0.5,vec3(1.0),260.0);
    col+=envSky(reflect(-V,Nf))*(0.05+0.60*pow(1.0-ndv,4.0));
    col+=vec3(0.45,0.82,1.0)*(0.06+0.5*wave+4.0*click);
  }
  if(any(isnan(col))||any(isinf(col))) col=vec3(0.7,0.78,0.9);
  gl_FragColor=vec4(clamp(col,0.0,40.0),1.0);
}`;

const quadVS=/*glsl*/`varying vec2 vUv; void main(){vUv=position.xy*0.5+0.5; gl_Position=vec4(position.xy,0.0,1.0);}`;

const skyFS=SKY+/*glsl*/`
uniform vec3 uCamR; uniform vec3 uCamU; uniform vec3 uCamF; uniform float uTan; uniform float uAspect; uniform float uTime;
varying vec2 vUv;
float h31(vec3 p){p=fract(p*0.3183099+0.1);p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float vnoise(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);
  return mix(mix(mix(h31(i),h31(i+vec3(1,0,0)),f.x),mix(h31(i+vec3(0,1,0)),h31(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(h31(i+vec3(0,0,1)),h31(i+vec3(1,0,1)),f.x),mix(h31(i+vec3(0,1,1)),h31(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float a=0.5,s=0.0;for(int i=0;i<5;i++){s+=a*vnoise(p);p=p*2.03+vec3(1.7,9.2,3.1);a*=0.5;}return s;}
float stars(vec3 rd,float sc,float thr){
  vec3 p=rd*sc; vec3 i=floor(p); vec3 f=fract(p)-0.5; float h=h31(i);
  vec3 o=vec3(h31(i+7.1),h31(i+13.3),h31(i+29.7))-0.5;
  float d=length(f-o*0.6);
  return step(thr,h)*(1.0-smoothstep(0.0,0.11,d))*(0.4+0.6*h31(i+3.3));
}
vec3 daySky(vec3 rd){
  vec3 c=skyBase(rd);
  float y=abs(rd.y);
  /* soft silk veils of high cloud, barely there */
  vec2 cp=rd.xz/(y+0.20)*0.45+vec2(uTime*0.010,0.0);
  float cl=fbm(vec3(cp,uTime*0.008));
  float cl2=fbm(vec3(rd*2.0+vec3(uTime*0.005,0.0,0.0)));
  float cm=smoothstep(0.50,0.86,cl)*(1.0-smoothstep(0.03,0.40,y))*0.30+smoothstep(0.58,0.88,cl2)*0.10;
  c=mix(c,vec3(0.90,0.94,1.0)*mix(1.0,0.90,step(rd.y,0.0)),cm);
  /* a few pale daylight stars */
  c+=vec3(1.0)*stars(rd,70.0,0.985)*0.35*smoothstep(0.1,0.5,rd.y);
  return c;
}
vec3 nightSky(vec3 rd0){
  vec3 rd=vec3(rd0.x,abs(rd0.y),rd0.z);
  float t=uTime*0.006;
  vec3 q=rd*1.7+vec3(t,0.0,-t);
  float w1=fbm(q*1.2+3.0);
  float n1=fbm(q*1.9+w1*1.8);
  float n2=fbm(q*3.1-w1*1.3+11.0);
  float bd=dot(rd,normalize(vec3(0.35,0.82,0.45)))*2.6; float band=exp(-bd*bd);
  vec3 col=vec3(0.004,0.006,0.013);
  col+=vec3(0.012,0.10,0.13)*pow(n1,3.2)*(0.4+1.6*band);
  col+=vec3(0.10,0.03,0.16)*pow(n2,3.6)*(0.3+1.2*band);
  col+=vec3(0.60,0.26,0.05)*pow(n1*n2*2.2,3.0)*band;
  float dark=smoothstep(0.35,0.62,fbm(q*2.6+20.0));
  col*=mix(1.0,0.35,dark*band);
  float tw=0.75+0.25*sin(uTime*1.7+rd.x*90.0+rd.y*70.0);
  float s=stars(rd,95.0,0.86)*0.9+stars(rd,190.0,0.80)*0.45+stars(rd,46.0,0.965)*2.6;
  col+=mix(vec3(0.65,0.8,1.0),vec3(1.0,0.82,0.6),h31(floor(rd*95.0)+1.0))*s*tw*(0.5+1.2*band);
  col+=vec3(0.05,0.07,0.12)*exp(-rd.y*22.0)*0.5;
  return col*mix(1.0,0.7,smoothstep(0.0,0.05,-rd0.y));
}
void main(){
  vec3 rd=normalize(uCamF+uCamR*(vUv.x*2.0-1.0)*uTan*uAspect+uCamU*(vUv.y*2.0-1.0)*uTan);
  vec3 c=vec3(0.0);
  if(uNight<0.999) c+=daySky(rd)*(1.0-uNight);
  if(uNight>0.001) c+=nightSky(rd)*uNight;
  gl_FragColor=vec4(c,1.0);
}`;

/* sigil: day = the great halo, the plumb line of light & its stars; night = the golden hexagram */
const sigilVS=/*glsl*/`
uniform float uMirror; varying vec2 vP;
void main(){vP=position.xy*${f(SIGK)}; vec3 wp=position; if(uMirror>0.5) wp.y=2.0*(${f(WY)})-wp.y;
  gl_Position=projectionMatrix*viewMatrix*vec4(wp,1.0);}`;
const sigilFS=`
uniform float uReveal;
uniform float uTime; uniform float uPulseR; uniform float uPulseAmp; uniform float uMirror; uniform float uNight;
varying vec2 vP;
float h11(float n){return fract(sin(n*91.345)*47453.5453);}
float ln(float d,float w){float fw=fwidth(d);return 1.0-smoothstep(w,w+fw*1.5,abs(d));}
float rhomb(vec2 p,vec2 s){return abs(p.x)/s.x+abs(p.y)/s.y;}
float ngon(vec2 p,float n,float rot){float a=atan(p.y,p.x)+rot;float sg=6.28318/n;a=mod(a,sg)-sg*0.5;return length(p)*cos(a);}
vec4 daySigil(vec2 p){
  float K=${f(SIGK)};
  float r=length(p); float a=atan(p.y,p.x);
  float RH=${f(RHALO)}*K;
  float g=0.0;
  g+=ln(r-RH,0.0055)*1.0;                          /* the great halo */
  g+=ln(r-RH*1.03,0.0022)*0.38;
    float tk=abs(fract((a-uTime*0.006)*11.459)-0.5)/11.459*r;   /* fine graduation */
  g+=(1.0-smoothstep(0.004,0.009,tk))*step(RH*1.006,r)*step(r,RH*1.022)*0.22;
  /* the plumb line of light */
  float top=RH+0.75*K, bot=${f(WY)}*K;
  float vl=ln(p.x,0.0042)*smoothstep(bot,bot+0.3,p.y)*(1.0-smoothstep(top-0.2,top+1.1,p.y));
  g+=vl*0.85;
  float beam=exp(-abs(p.x)*7.0)*(1.0-smoothstep(top-1.5,top+1.4,p.y))*smoothstep(bot-0.2,bot+1.5,p.y);
  /* tiny diamonds threaded on the line */
  float mk=0.0;
  mk+=1.0-smoothstep(0.85,1.0,rhomb(p-vec2(0.0,0.62*RH),vec2(0.05,0.12)));
  mk+=1.0-smoothstep(0.85,1.0,rhomb(p-vec2(0.0,-0.72*RH),vec2(0.04,0.10)));
  g+=mk*0.8;
  /* breath of light behind the knot */
  float glow=exp(-r*r*0.45)*0.045;
  float pd=(r-uPulseR*K)/0.16; float pr=exp(-pd*pd)*uPulseAmp;
  g*=1.0+pr*4.0; g+=pr*0.6*smoothstep(7.5,4.0,r);
  float fade=1.0-smoothstep(5.0,7.2,r)*(1.0-step(abs(p.x),0.06));
  vec3 rgb=vec3(0.97,0.99,1.0)*g*1.7*fade+vec3(0.90,0.95,1.0)*(beam*0.07+glow);
  float al=clamp(g*0.55*fade,0.0,1.0);
  return vec4(rgb,al);
}
vec3 nightSigil(vec2 p){
  float r=length(p); float a=atan(p.y,p.x);
  float g=0.0;
  g+=ln(r-1.075,0.006)*0.9+ln(r-2.15,0.008)+ln(r-2.23,0.003)*0.6;
  g+=ln(r-4.05,0.008)+ln(r-4.55,0.008)+ln(r-4.63,0.003)*0.6+ln(r-5.5,0.010)*0.6;
  float inner=1.0-step(2.15,r);
  g+=(ln(ngon(p,3.0,uTime*0.05)-1.075,0.006)+ln(ngon(p,3.0,uTime*0.05+3.14159)-1.075,0.006))*inner*0.85;
  g+=ln(ngon(p,4.0,-uTime*0.08)-0.7601,0.005)*(1.0-step(1.075,r))*0.8;
  g+=ln(r-0.62,0.004)*0.6;
  float sgn=6.28318/40.0; float aa=a+uTime*0.03; float idx=floor(aa/sgn);
  float u=fract(aa/sgn), v=(r-4.05)/0.5;
  float inb=step(0.0,v)*step(v,1.0);
  float h1=h11(idx+1.0),h2=h11(idx+17.0),h3=h11(idx+41.0),h4=h11(idx+77.0);
  float du=(u-0.5)*sgn*r;
  float gl=0.0;
  gl+=step(0.25,h1)*ln(du,0.007)*step(0.2,v)*step(v,0.8);
  gl+=step(0.35,h2)*ln((v-(0.28+0.12*h3))*0.5,0.007)*step(abs(du),0.12);
  gl+=step(0.45,h3)*ln((v-(0.62+0.12*h1))*0.5,0.007)*step(abs(du+0.05),0.09);
  gl+=step(0.5,h4)*ln(du-(v-0.5)*0.22,0.007)*step(0.25,v)*step(v,0.75);
  gl+=step(0.7,h2)*(1.0-smoothstep(0.02,0.03,length(vec2(du-0.09,(v-0.5)*0.5))));
  g+=gl*inb*0.9;
  float tk=abs(fract((a-uTime*0.02)*19.0986)-0.5)/19.0986*r;
  g+=(1.0-smoothstep(0.004,0.010,tk))*step(5.36,r)*step(r,5.5)*0.7;
  float tk2=abs(fract((a+uTime*0.015)*5.7296)-0.5)/5.7296*r;
  g+=(1.0-smoothstep(0.005,0.012,tk2))*step(5.5,r)*step(r,5.72)*0.7;
  float ha=uTime*0.35;
  float sw=pow(1.0-mod(ha-a,6.28318)/6.28318,5.0);
  g*=0.30+1.9*sw;
  float pd=(r-uPulseR*${f(SIGK)})/0.14; float pr=exp(-pd*pd)*uPulseAmp;
  g+=pr*1.4+g*pr*6.0;
  float fade=(1.0-smoothstep(5.2,6.6,r));
  return vec3(1.0,0.60,0.20)*g*0.62*fade;
}
void main(){
  vec4 d=vec4(0.0); vec3 nn=vec3(0.0);
  if(uNight<0.999) d=daySigil(vP)*(1.0-uNight);
  if(uNight>0.001) nn=nightSigil(vP)*uNight;
  float ang=acos(clamp(vP.y/max(length(vP),1e-4),-1.0,1.0))/3.14159;
  float rv=mix(0.06,1.0,1.0-smoothstep(uReveal*1.08-0.08,uReveal*1.08,ang));
  d*=rv; nn*=rv;
  vec3 rgb=d.rgb+nn;
  if(uMirror>0.5) rgb*=mix(0.75,0.55,uNight);
  gl_FragColor=vec4(rgb,d.a);
}`;

/* black sun (night) */
const coreVS=/*glsl*/`
uniform vec3 uCamR; uniform vec3 uCamU; varying vec2 vQ;
void main(){vQ=position.xy; vec3 wp=vec3(0.0,0.0,${f(SIGZ+0.05)})+(uCamR*position.x+uCamU*position.y)*2.4; gl_Position=projectionMatrix*viewMatrix*vec4(wp,1.0);}`;
const coreFS=/*glsl*/`
uniform float uTime; uniform float uCore; uniform float uNight; varying vec2 vQ;
void main(){
  float r=length(vQ)*2.3; float a=atan(vQ.y,vQ.x);
  float rays=0.5+0.5*sin(a*7.0+uTime*0.31)*sin(a*13.0-uTime*0.23);
  rays=mix(rays,0.5+0.5*sin(a*29.0+uTime*0.5),0.25);
  float disc=smoothstep(0.27,0.31,r);
  float rg=(r-0.325)/0.03; float ring=exp(-rg*rg);
  float corona=disc*(0.06/(r*r+0.02))*(0.45+0.55*rays);
  vec3 col=vec3(1.0,0.78,0.48)*ring*3.0+vec3(1.0,0.48,0.14)*corona*0.6+vec3(0.9,0.35,0.10)*disc*0.02/(r+0.05);
  col*=(1.0-smoothstep(1.2,2.3,r))*uCore*uNight;
  gl_FragColor=vec4(col,(1.0-disc)*uNight*0.97);
}`;

/* glass ribbons (orbit rings) */
const glassVS=/*glsl*/`
uniform vec3 uCenter; uniform vec3 uRx; uniform vec3 uRy; uniform vec3 uRz;
attribute vec2 aI;
varying vec3 vW; varying vec3 vN; varying vec2 vI;
void main(){
  mat3 M=mat3(uRx,uRy,uRz);
  vec3 wp=uCenter+M*position;
  vW=wp; vN=M*normal; vI=aI;
  gl_Position=projectionMatrix*viewMatrix*vec4(wp,1.0);
}`;
const glassFS=/*glsl*/`
uniform float uTime; uniform float uGain; uniform float uPulseAmp; uniform float uNight;
varying vec3 vW; varying vec3 vN; varying vec2 vI;
void main(){
  vec3 N=normalize(vN); vec3 V=normalize(cameraPosition-vW);
  float ndv=abs(dot(N,V));
  float F=pow(1.0-ndv,3.0);
  float edge=smoothstep(0.70,0.98,abs(vI.y));
  vec3 irid=0.5+0.5*cos(6.28318*(ndv*1.3+vI.x*0.15+vec3(0.0,0.33,0.67)));
  float sweep=pow(0.5+0.5*sin(vI.x*0.5-uTime*0.9),30.0);
  vec3 tint=mix(vec3(0.97,0.99,1.0),vec3(1.0,0.70,0.35),uNight);
  vec3 col=tint*(0.35+F*1.4+edge*1.8+sweep*3.0+uPulseAmp*1.5)+irid*0.30*F*(1.0-uNight);
  float a=clamp(0.20+0.5*F+0.6*edge+0.3*sweep,0.0,1.0)*uGain*mix(1.0,0.55,uNight);
  gl_FragColor=vec4(col*a,a*0.70*(1.0-uNight*0.8));
}`;

/* mirror water */
const waterVS=/*glsl*/`varying vec3 vW; void main(){vW=position; gl_Position=projectionMatrix*viewMatrix*vec4(position,1.0);}`;
const waterFS=SKY+/*glsl*/`
uniform float uTime; uniform float uPulseR; uniform float uPulseAmp;
varying vec3 vW;
float hh(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
void main(){
  float n=uNight;
  vec2 q=vW.xz; float r=length(q)+1e-4;
  float t=uTime;
  float dh=0.030*cos(r*5.5-t*1.1)/(1.0+0.35*r)+0.018*cos(r*11.0-t*1.9+q.x*0.5)/(1.0+0.5*r);
  float pd=(r-uPulseR*1.7)/0.25;
  dh+=0.25*uPulseAmp*(-2.0*pd)*exp(-pd*pd)/(1.0+0.15*r);
  vec2 gr=(q/r)*dh;
  gr+=vec2(sin(q.y*1.7+t*0.6)+sin(q.x*2.3-t*0.4),cos(q.x*1.9+t*0.5)+cos(q.y*2.7+t*0.7))*0.010;
  vec3 N=normalize(vec3(-gr.x,1.0,-gr.y));
  vec3 V=normalize(cameraPosition-vW);
  float ndv=max(dot(N,V),0.0);
  float F=0.03+0.97*pow(1.0-ndv,5.0);
  vec3 dayBody=mix(vec3(0.70,0.80,0.97),vec3(0.36,0.50,0.82),smoothstep(1.0,15.0,vW.z));
  vec3 body=mix(dayBody,vec3(0.004,0.008,0.02),n);
  float a=(1.0-F)*mix(0.62,0.45,n);
  float fade=1.0-smoothstep(16.0,44.0,r);
  vec3 lc=mix(vec3(0.95,0.98,1.0),vec3(1.0,0.62,0.24),n);
  vec3 em=vec3(0.0);
  float R[5]; R[0]=2.4; R[1]=4.1; R[2]=6.0; R[3]=8.3; R[4]=11.0;
  float I[5]; I[0]=1.0; I[1]=0.9; I[2]=0.7; I[3]=0.5; I[4]=0.3;
  for(int i=0;i<5;i++){
    float rr=R[i]*(1.0+0.015*sin(t*0.6+float(i)*1.7));
    float e=(r-rr)/0.028; float ld=exp(-e*e);
    float e2=(r-rr)/0.25; float soft=exp(-e2*e2)*0.10;
    float sp=pow(0.5+0.5*sin(atan(q.y,q.x)*7.0-t*0.6*(float(i)+1.0)),6.0);
    em+=lc*(ld*(0.7+1.0*sp)+soft)*I[i]*mix(1.0,0.8,n);
  }
  em+=lc*(exp(-r*r*4.0)*mix(0.8,1.6,n)+exp(-r*0.9)*mix(0.07,0.14,n));
  float pe=(r-uPulseR*1.7)/0.06; em+=lc*exp(-pe*pe)*uPulseAmp*3.0;
  vec2 cell=floor(q*9.0); float h=hh(cell);
  vec2 lcl=fract(q*9.0)-0.5; float glint=step(0.990,h)*pow(0.5+0.5*sin(t*(2.0+h*6.0)+h*60.0),16.0)*(1.0-smoothstep(1.5,13.0,r))*exp(-dot(lcl,lcl)*60.0);
  em+=mix(vec3(1.0),vec3(1.0,0.8,0.5),n)*glint*2.5;
  float spec=pow(max(dot(reflect(-V,N),mix(uSunDir,uCoreDir,n)),0.0),300.0)*3.0;
  em+=mix(vec3(1.0),vec3(1.0,0.7,0.35),n)*spec;
  gl_FragColor=vec4((body*a+em)*fade,a*fade);
}`;

/* particles */
const flowVS=PATH+/*glsl*/`
attribute float aRnd;
uniform float uPx; uniform float uBurst; uniform vec3 uPointer; uniform float uPointerI; uniform float uPal; uniform vec2 uRho;
varying vec3 vCol; varying float vA;
void main(){
  float rn=aRnd;
  float u=position.x+uTime*mix(0.03,0.16,rn)+uSpin*0.6;
  float rho=uRho.x+uRho.y*pow(position.y,2.2);
  rho*=1.0+uBurst*(0.35+1.3*fract(rn*9.7));
  float psi=position.z+uTime*mix(0.25,1.0,fract(rn*7.3))+u*2.0;
  vec3 C,T,D,S; pathFrame(u,C,T,D,S);
  vec3 wp=C+(D*cos(psi)+S*sin(psi))*rho;
  vec3 dp=wp-uPointer; float d2=dot(dp,dp);
  wp+=normalize(dp+1e-4)*uPointerI*1.1*exp(-d2*0.9);
  vec4 mv=viewMatrix*vec4(wp,1.0);
  gl_Position=projectionMatrix*mv;
  float tw=0.55+0.45*sin(uTime*(1.0+rn*4.0)+rn*40.0);
  float sz=uPx*(0.012+0.030*pow(fract(rn*13.7),2.0))*(0.6+0.4*tw)/max(-mv.z,0.1);
  gl_PointSize=max(sz,1.2);
  float hot=uPointerI*exp(-d2*0.5);
  vec3 day=mix(vec3(1.0,1.0,1.0),vec3(0.45,0.70,1.0),fract(rn*3.1));
  vec3 night=mix(vec3(1.0,0.50,0.13),vec3(0.30,0.95,0.85),smoothstep(0.80,1.0,fract(rn*3.1)));
  vCol=mix(day,night,uPal)*(1.0+uBurst*1.2)+vec3(0.5,0.8,1.0)*hot*1.5;
  vA=(0.25+0.75*fract(rn*5.7))*tw*min(sz/1.2,1.0)*smoothstep(0.3,1.5,-mv.z);
}`;
const moteVS=/*glsl*/`
attribute float aRnd;
uniform float uTime; uniform float uPx;
varying vec3 vCol; varying float vA;
void main(){
  float a=uTime*0.01; float c=cos(a), s=sin(a);
  vec3 wp=vec3(position.x*c-position.z*s,position.y+sin(uTime*0.15+aRnd*30.0)*0.25,position.x*s+position.z*c);
  vec4 mv=viewMatrix*vec4(wp,1.0);
  gl_Position=projectionMatrix*mv;
  float sz=uPx*(0.02+0.09*pow(aRnd,4.0))/max(-mv.z,0.1);
  gl_PointSize=max(sz,1.2);
  vCol=mix(vec3(1.0),vec3(0.75,0.90,1.0),fract(aRnd*7.7));
  vA=(0.18+0.45*fract(aRnd*3.3))*(0.7+0.3*sin(uTime*(0.5+aRnd*2.0)+aRnd*50.0))*min(sz/1.2,1.0)*smoothstep(0.5,3.0,-mv.z);
}`;
const glintVS=PATH+/*glsl*/`
attribute float aRnd;
uniform float uPx; uniform float uRoll0; uniform float uRoll1;
varying vec3 vCol; varying float vA;
void main(){
  float s=position.x;
  float which=step(0.5,fract(aRnd*3.7));
  float u=uSpin+which*3.14159265-s*LBODY*(6.2831853/CIRC);
  vec3 C,T,D,S; pathFrame(u,C,T,D,S);
  float r=mix(0.40,0.53,smoothstep(0.0,0.05,s))*mix(1.0,0.42,smoothstep(0.36,0.97,s));
  float psi=position.y;
  float ra=mix(uRoll0,uRoll1,which)*smoothstep(-3.8,-0.2,-s*LBODY);
  psi+=ra;
  vec3 wp=C+(D*cos(psi)*0.98+S*sin(psi)*1.07)*(r+0.015);
  vec4 mv=viewMatrix*vec4(wp,1.0);
  gl_Position=projectionMatrix*mv;
  float fl=pow(max(sin(uTime*(0.5+aRnd*1.3)+aRnd*80.0),0.0),36.0);
  float sz=uPx*(0.10+0.16*fract(aRnd*7.3))*fl/max(-mv.z,0.1);
  gl_PointSize=sz;
  vCol=vec3(1.0,1.0,1.0);
  vA=fl*step(1.5,sz);
}`;
/* wake: a comet-tail of light shed behind each flying dragon */
const wakeVS=PATH+TRACK+/*glsl*/`
attribute float aRnd;
uniform float uPx; uniform float uWake; uniform float uNight;
varying vec3 vCol; varying float vA;
void main(){
  float rn=aRnd;
  float age=fract(position.x+uTime*(0.32+0.22*fract(rn*5.3)));
  float behind=age*22.0+0.2;
  vec3 C,T,D,S; trackFrame(HLEN-behind,C,T,D,S);
  float rho=0.30+age*age*3.6*(0.35+fract(rn*9.1));
  float psi=position.y+uTime*(0.6+fract(rn*3.7))+age*7.0;
  vec3 wp=C+(D*cos(psi)+S*sin(psi))*rho-T*age*0.6;
  vec4 mv=viewMatrix*vec4(wp,1.0);
  gl_Position=projectionMatrix*mv;
  float sz=uPx*(0.014+0.045*pow(fract(rn*13.7),3.0))*(1.0-age*0.45)/max(-mv.z,0.1);
  gl_PointSize=max(sz,1.2);
  vec3 day=mix(vec3(1.0),vec3(0.42,0.68,1.0),fract(rn*3.1));
  vec3 night=mix(vec3(1.0,0.60,0.20),vec3(0.55,0.82,1.0),step(0.72,fract(rn*3.1)));
  vCol=mix(day,night,uNight)*(1.7-age);
  vA=uWake*pow(1.0-age,1.5)*min(sz/1.2,1.0)*smoothstep(0.3,1.5,-mv.z);
}`;
/* fixed four-pointed stars: on the plumb line, on the halo, on the water */
const sparkVS=/*glsl*/`
attribute float aRnd; attribute float aSize;
uniform float uTime; uniform float uPx; uniform float uPulseAmp;
varying vec3 vCol; varying float vA;
void main(){
  vec4 mv=viewMatrix*vec4(position,1.0);
  gl_Position=projectionMatrix*mv;
  float tw=0.72+0.28*sin(uTime*(0.7+aRnd*2.2)+aRnd*40.0);
  float sz=uPx*aSize*(0.82+0.18*tw)*(1.0+uPulseAmp*0.35)/max(-mv.z,0.1);
  gl_PointSize=sz;
  vCol=vec3(1.0,1.0,1.0); vA=tw*min(sz/3.0,1.0);
}`;
/* night particles */
const discVS=/*glsl*/`
attribute float aRnd;
uniform float uTime; uniform float uPx; uniform float uBurst;
varying vec3 vCol; varying float vA;
void main(){
  float rn=aRnd;
  float cyc=fract(position.y-uTime*0.010*(0.5+rn));
  float r=mix(0.42,8.5,pow(cyc,1.3));
  r*=1.0+uBurst*0.12;
  float ang=position.x+2.6*log(r+0.25)+uTime*0.045;
  vec3 wp=vec3(r*cos(ang),r*sin(ang),${f(SIGZ)}+(position.z-0.5)*(0.05+0.09*r));
  vec4 mv=viewMatrix*vec4(wp,1.0);
  gl_Position=projectionMatrix*mv;
  float sz=uPx*(0.010+0.022*fract(rn*11.3))/max(-mv.z,0.1);
  gl_PointSize=max(sz,1.2);
  vCol=mix(vec3(1.0,0.72,0.40),mix(vec3(0.20,0.75,0.85),vec3(0.55,0.30,0.95),fract(rn*4.7)),smoothstep(0.8,5.5,r));
  vA=smoothstep(0.0,0.05,cyc)*(1.0-smoothstep(0.80,1.0,cyc))*(0.20+0.5*fract(rn*6.1))*min(sz/1.2,1.0)*smoothstep(0.3,1.5,-mv.z);
}`;
const dustVS=/*glsl*/`
attribute float aRnd;
uniform float uTime; uniform float uPx;
varying vec3 vCol; varying float vA;
void main(){
  float a=uTime*0.008; float c=cos(a), s=sin(a);
  vec3 wp=vec3(position.x*c-position.z*s,position.y+sin(uTime*0.1+aRnd*30.0)*0.15,position.x*s+position.z*c);
  vec4 mv=viewMatrix*vec4(wp,1.0);
  gl_Position=projectionMatrix*mv;
  float sz=uPx*(0.015+0.05*pow(aRnd,3.0))/max(-mv.z,0.1);
  gl_PointSize=max(sz,1.2);
  vCol=mix(vec3(0.55,0.75,1.0),vec3(1.0,0.80,0.55),fract(aRnd*7.7));
  vA=(0.25+0.5*fract(aRnd*3.3))*(0.7+0.3*sin(uTime*(0.5+aRnd*2.0)+aRnd*50.0))*min(sz/1.2,1.0)*smoothstep(0.5,3.0,-mv.z);
}`;
const pointFS=/*glsl*/`
uniform float uGain; varying vec3 vCol; varying float vA;
void main(){
  vec2 q=gl_PointCoord-0.5; float d=dot(q,q)*4.0;
  float a=exp(-d*5.0)-0.0067;
  if(a<=0.0) discard;
  gl_FragColor=vec4(vCol*uGain,a*vA);
}`;
const glintFS=/*glsl*/`
uniform float uGain; varying vec3 vCol; varying float vA;
void main(){
  vec2 q=gl_PointCoord-0.5;
  float a=exp(-abs(q.x)*55.0)*exp(-abs(q.y)*5.0)+exp(-abs(q.y)*55.0)*exp(-abs(q.x)*5.0);
  vec2 qr=vec2(q.x+q.y,q.x-q.y)*0.7071;
  a+=(exp(-abs(qr.x)*60.0)*exp(-abs(qr.y)*12.0)+exp(-abs(qr.y)*60.0)*exp(-abs(qr.x)*12.0))*0.45;
  a+=exp(-dot(q,q)*120.0)*1.5+exp(-dot(q,q)*18.0)*0.25;
  a*=1.0-smoothstep(0.35,0.5,length(q));
  if(a<0.004) discard;
  gl_FragColor=vec4(vCol*uGain,a*vA);
}`;

/* post */
const brightFS=/*glsl*/`
uniform sampler2D tD; uniform vec2 uTexel; uniform float uNight; varying vec2 vUv;
void main(){
  vec3 c=(texture2D(tD,vUv+uTexel*vec2(-0.5,-0.5)).rgb+texture2D(tD,vUv+uTexel*vec2(0.5,-0.5)).rgb
         +texture2D(tD,vUv+uTexel*vec2(-0.5,0.5)).rgb+texture2D(tD,vUv+uTexel*vec2(0.5,0.5)).rgb)*0.25;
  if(any(isnan(c))||any(isinf(c))) c=vec3(0.0);
  c=clamp(c,0.0,16.0);
  float br=max(c.r,max(c.g,c.b));
  c*=smoothstep(mix(0.95,1.2,uNight),mix(2.4,2.6,uNight),br);
  gl_FragColor=vec4(c,1.0);
}`;
const downFS=/*glsl*/`
uniform sampler2D tD; uniform vec2 uTexel; varying vec2 vUv;
void main(){
  vec3 c=texture2D(tD,vUv).rgb*4.0;
  c+=texture2D(tD,vUv+uTexel*vec2(-1.0,-1.0)).rgb+texture2D(tD,vUv+uTexel*vec2(1.0,-1.0)).rgb
    +texture2D(tD,vUv+uTexel*vec2(-1.0,1.0)).rgb+texture2D(tD,vUv+uTexel*vec2(1.0,1.0)).rgb;
  gl_FragColor=vec4(c*0.125,1.0);
}`;
const upFS=/*glsl*/`
uniform sampler2D tD; uniform sampler2D tAdd; uniform vec2 uTexel; varying vec2 vUv;
void main(){
  vec3 c=texture2D(tD,vUv).rgb*4.0;
  c+=(texture2D(tD,vUv+uTexel*vec2(-1.0,0.0)).rgb+texture2D(tD,vUv+uTexel*vec2(1.0,0.0)).rgb
     +texture2D(tD,vUv+uTexel*vec2(0.0,-1.0)).rgb+texture2D(tD,vUv+uTexel*vec2(0.0,1.0)).rgb)*2.0;
  c+=texture2D(tD,vUv+uTexel*vec2(-1.0,-1.0)).rgb+texture2D(tD,vUv+uTexel*vec2(1.0,-1.0)).rgb
    +texture2D(tD,vUv+uTexel*vec2(-1.0,1.0)).rgb+texture2D(tD,vUv+uTexel*vec2(1.0,1.0)).rgb;
  gl_FragColor=vec4(c*0.0625+texture2D(tAdd,vUv).rgb,1.0);
}`;
const godFS=/*glsl*/`
uniform sampler2D tD; uniform vec2 uSun; uniform float uAspect; uniform float uNight; varying vec2 vUv;
void main(){
  vec2 dl=(vUv-uSun)*(0.9/36.0);
  vec2 uv=vUv;
  vec3 acc=vec3(0.0); float dc=1.0;
  float rad=mix(0.18,0.30,uNight);
  for(int i=0;i<36;i++){
    vec2 q=(uv-uSun)*vec2(uAspect,1.0);
    float m=1.0-smoothstep(0.01,rad,length(q));
    acc+=texture2D(tD,uv).rgb*dc*m; dc*=0.95; uv-=dl;
  }
  gl_FragColor=vec4(acc/36.0,1.0);
}`;
const finalFS=/*glsl*/`
uniform sampler2D tScene; uniform sampler2D tBloom; uniform sampler2D tGod;
uniform float uTime; uniform float uFade; uniform float uFlash; uniform vec2 uRes; uniform float uGodI; uniform float uNight;
varying vec2 vUv;
float hh(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
vec3 aces(vec3 x){return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0);}
/* day: near-linear up to the shoulder, then a soft roll into white (keeps the pale sky honest) */
vec3 soft(vec3 x){const float k=0.70; vec3 y=k+(1.0-k)*(1.0-exp(-(x-k)/(1.0-k))); return mix(x,y,step(k,x));}
void main(){
  float n=uNight;
  vec2 c=vUv-0.5; float r2=dot(c,c);
  vec2 ca=c*(0.0005+r2*0.003)*(1.0+uFlash*4.0);
  vec3 col=vec3(texture2D(tScene,vUv+ca).r,texture2D(tScene,vUv).g,texture2D(tScene,vUv-ca).b);
  if(any(isnan(col))||any(isinf(col))) col=vec3(0.0);
  vec3 bl=vec3(texture2D(tBloom,vUv+ca).r,texture2D(tBloom,vUv).g,texture2D(tBloom,vUv-ca).b);
  col+=bl*mix(0.075,0.09,n)*(1.0+uFlash*0.8);
  col+=texture2D(tGod,vUv).rgb*mix(vec3(0.90,0.95,1.0)*0.06,vec3(1.0,0.80,0.55)*0.40,n)*uGodI;
  col*=1.0-mix(0.10,0.70,n)*smoothstep(0.14,0.62,r2);
  vec3 dayC=soft(col*(1.0+uFlash*0.12));
  vec3 nightC=aces(col*1.15*(1.0+uFlash*0.15));
  float l=dot(nightC,vec3(0.2126,0.7152,0.0722));
  nightC=mix(nightC*vec3(0.90,1.0,1.10),nightC*vec3(1.07,1.0,0.90),smoothstep(0.0,0.7,l));
  float ld=dot(dayC,vec3(0.2126,0.7152,0.0722));
  dayC=mix(dayC*vec3(0.97,0.99,1.03),dayC,smoothstep(0.2,0.9,ld));
  col=mix(dayC,nightC,n);
  col=pow(clamp(col,0.0,1.0),vec3(0.4545));
  col+=(hh(vUv*uRes+fract(uTime)*91.7)-0.5)*mix(0.010,0.02,n);
  col=mix(mix(vec3(0.985,0.99,1.0),vec3(0.0),n),col,uFade);
  gl_FragColor=vec4(col,1.0);
}`;

/* ------------------------------------------------------------------ */
/*  Renderer / scene                                                   */
/* ------------------------------------------------------------------ */

await yieldForInteraction();
checkCancelled();
try{ renderer=new L3.Renderer({canvas}); }
catch(e){ throw e; }
const scene=new L3.Scene();
const FOV=38, TANF=Math.tan(FOV*Math.PI/360);
const camera=new L3.PerspectiveCamera(FOV,1,0.1,200);

const V3=(x=0,y=0,z=0)=>new L3.Vec3(x,y,z), V2=(x=0,y=0)=>new L3.Vec2(x,y);
const U={
  uTime:{value:0},uSpin:{value:0},uPointer:{value:V3()},uPointerI:{value:0},
  uPulsePos:{value:0},uPulseAmp:{value:0},uCore:{value:1},uBurst:{value:0},uPx:{value:1000},
  uCamR:{value:V3()},uCamU:{value:V3()},uCamF:{value:V3()},uTan:{value:TANF},uAspect:{value:1},
  uPulseR:{value:0},uSunDir:{value:V3(0,0.3,-1)},uCoreDir:{value:V3(0,0,-1)},uLightPos:{value:V3(...STAR)},
  uNight:{value:0},uRoll0:{value:0},uRoll1:{value:0},uReveal:{value:0},
  uFC:{value:FC.map(v=>V3(...v))},uFS:{value:FSn.map(v=>V3(...v))}
};
const pick=(...k)=>Object.fromEntries(k.map(n=>[n,U[n]]));
const geo=(pos,idx)=>{const g=new L3.Geometry();g.setAttribute('position',new Float32Array(pos),3);g.setIndex(new Uint16Array(idx));return g;};
const quadGeo=geo([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0],[0,1,2,0,2,3]);
const addObj=(o,order)=>{o.renderOrder=order;scene.add(o);return o;};
const SM=o=>new L3.Material(o);
const PREM={blending:L3.PremulBlend,depthWrite:false};
const ADD={blending:L3.AddBlend,depthWrite:false};

addObj(new L3.Mesh(quadGeo,SM({vertexShader:quadVS,fragmentShader:skyFS,depthTest:false,depthWrite:false,
  uniforms:pick('uCamR','uCamU','uCamF','uTan','uAspect','uTime','uSunDir','uCoreDir','uNight')})),-10);

const snakeU=pick('uTime','uSpin','uFC','uFS','uPointer','uPointerI','uPulsePos','uPulseAmp','uCore','uSunDir','uCoreDir','uNight','uLightPos');
const rollU=[U.uRoll0,U.uRoll1];
const DU=[0,1].map(i=>({uE:{value:ENT[i].pts.map(p=>V3(...p))},uEG:{value:V3(...ENT[i].ghost)},uEStep:{value:ENT[i].step},uHead:{value:0},
  uJoin:{value:ENT[i].u},uJC:{value:V3(...ENT[i].pts[0])}}));
[0,1].forEach(i=>{for(const mir of [1,0])
  addObj(new L3.Mesh(snakeGeo,SM({vertexShader:snakeVS,fragmentShader:snakeFS,
    uniforms:{...snakeU,...DU[i],uMirror:{value:mir},uRoll:rollU[i]}})),mir?-6:0);});

const SX=7.6/SIGK, SY=8.4/SIGK;
const sigilGeo=geo([-SX,WY,SIGZ, SX,WY,SIGZ, SX,SY,SIGZ, -SX,SY,SIGZ],[0,1,2,0,2,3]);
const sigU=pick('uTime','uPulseR','uPulseAmp','uNight','uReveal');
addObj(new L3.Mesh(sigilGeo,SM({vertexShader:sigilVS,fragmentShader:sigilFS,...PREM,uniforms:{...sigU,uMirror:{value:1}}})),-5);
addObj(new L3.Mesh(sigilGeo,SM({vertexShader:sigilVS,fragmentShader:sigilFS,...PREM,uniforms:{...sigU,uMirror:{value:0}}})),1);
const coreMesh=addObj(new L3.Mesh(quadGeo,SM({vertexShader:coreVS,fragmentShader:coreFS,...PREM,
  uniforms:pick('uTime','uCore','uCamR','uCamU','uNight')})),0.5);

const W=60;
addObj(new L3.Mesh(geo([-W,WY,-W, W,WY,-W, W,WY,W, -W,WY,W],[0,2,1,0,3,2]),SM({vertexShader:waterVS,fragmentShader:waterFS,
  ...PREM,depthWrite:true,uniforms:pick('uTime','uPulseR','uPulseAmp','uSunDir','uCoreDir','uNight')})),-4);

/* glass orbit rings */
function ribbon(R,hw,seg){
  const pos=[],nor=[],ai=[],idx=[];
  for(let i=0;i<=seg;i++){const a=i/seg*TAU,c=Math.cos(a),s=Math.sin(a);
    for(const v of [-1,1]){pos.push(R*c,v*hw,R*s);nor.push(c,0,s);ai.push(a*R,v);}}
  for(let i=0;i<seg;i++){const a=i*2;idx.push(a,a+1,a+2,a+1,a+3,a+2);}
  const g=new L3.Geometry();
  g.setAttribute('position',new Float32Array(pos),3);g.setAttribute('normal',new Float32Array(nor),3);
  g.setAttribute('aI',new Float32Array(ai),2);g.setIndex(new Uint16Array(idx));
  return g;
}
const rings=[
  {geo:ribbon(2.9,0.014,240),c:[0,-2.75,-0.6],gain:1.1,f:t=>[0.04*Math.sin(t*0.21),t*0.03,0.03*Math.sin(t*0.17)]},
  {geo:ribbon(7.4,0.010,400),c:[0,0.0,-0.8],gain:0.30,f:t=>[1.42,t*0.04,0.30+0.05*Math.sin(t*0.13)]},
  {geo:ribbon(1.3,0.010,160),c:[0,2.45,SIGZ+0.3],gain:0.6,f:t=>[1.25+0.3*Math.sin(t*0.3),t*0.22,0.4]}
];
for(const r of rings){
  r.u={uRx:{value:V3()},uRy:{value:V3()},uRz:{value:V3()},uCenter:{value:V3(...r.c)},uGain:{value:r.gain}};
  addObj(new L3.Mesh(r.geo,SM({vertexShader:glassVS,fragmentShader:glassFS,...PREM,
    uniforms:{...r.u,...pick('uTime','uPulseAmp','uNight')}})),2);
}
function setRot(r,t){
  const [ax,ay,az]=r.f(t);
  const cx=Math.cos(ax),sx=Math.sin(ax),cy=Math.cos(ay),sy=Math.sin(ay),cz=Math.cos(az),sz=Math.sin(az);
  const m=[[cy*cz, cy*sz, -sy],[sx*sy*cz-cx*sz, sx*sy*sz+cx*cz, sx*cy],[cx*sy*cz+sx*sz, cx*sy*sz-sx*cz, cx*cy]];
  r.u.uRx.value.set(...m[0]);r.u.uRy.value.set(...m[1]);r.u.uRz.value.set(...m[2]);
}

/* particle groups: each fades in/out with day ↔ night */
const groups=[];
async function pointsObj(n,fill,vs,fs,gain,order,uni,night,extra){
  const p=new Float32Array(n*3),r=new Float32Array(n);
  for(let i=0;i<n;i++){
    fill(p,i*3,i);r[i]=rnd();
    if(i>0&&i%512===0){await yieldForInteraction();checkCancelled();}
  }
  const g=new L3.Geometry();
  g.setAttribute('position',p,3);g.setAttribute('aRnd',r,1);
  if(extra)for(const k in extra)g.setAttribute(k,extra[k],1);
  const gu={value:gain};
  const o=addObj(new L3.Points(g,SM({vertexShader:vs,fragmentShader:fs,...ADD,uniforms:{...uni,uGain:gu}})),order);
  groups.push({o,gu,gain,night});
  return o;
}
const flowU=pick('uTime','uSpin','uFC','uFS','uPx','uBurst','uPointer','uPointerI');
// day
await pointsObj(2400,(p,i)=>{const a=rnd()*TAU,r=2+Math.pow(rnd(),0.7)*20;p[i]=r*Math.cos(a);p[i+1]=WY+0.6+rnd()*13;p[i+2]=r*Math.sin(a)*0.8;},
  moteVS,pointFS,1.5,3,pick('uTime','uPx'),false);
await pointsObj(7000,(p,i)=>{p[i]=rnd()*TAU;p[i+1]=rnd();p[i+2]=rnd()*TAU;},
  flowVS,pointFS,1.3,4,{...flowU,uPal:{value:0},uRho:{value:V2(0.66,1.3)}},false);
await pointsObj(480,(p,i)=>{p[i]=0.02+0.86*rnd();p[i+1]=Math.PI/2+(rnd()*2-1)*1.3;if(rnd()<0.5)p[i+1]+=Math.PI;p[i+2]=0;},
  glintVS,glintFS,2.6,5,pick('uTime','uSpin','uFC','uFS','uPx','uRoll0','uRoll1'),false);
{
  const S=[[0,RHALO,SIGZ,1.25],[0,2.45,SIGZ,0.70],[0,-1.95,SIGZ,0.42],[0,-2.85,SIGZ,0.60],[0,WY+0.03,0.0,1.5],
           [-RHALO*0.7071,RHALO*0.7071,SIGZ,0.30],[RHALO*0.7071,-RHALO*0.7071,SIGZ,0.26],[RHALO,0,SIGZ,0.22],[-RHALO,0,SIGZ,0.22]];
  for(let i=0;i<16;i++){const a=rnd()*TAU,r=5+rnd()*5;S.push([r*Math.cos(a)*1.1,1.2+r*Math.sin(a)*0.75,-3-rnd()*6,0.10+0.16*rnd()*rnd()]);}
  const sz=new Float32Array(S.length);
  await pointsObj(S.length,(p,i,k)=>{p[i]=S[k][0];p[i+1]=S[k][1];p[i+2]=S[k][2];sz[k]=S[k][3];},
    sparkVS,glintFS,1.9,6,pick('uTime','uPx','uPulseAmp'),false,{aSize:sz});
}
// night
await pointsObj(7000,(p,i)=>{const u=rnd()*2-1,a=rnd()*TAU,r=6+Math.pow(rnd(),0.6)*34,s=Math.sqrt(1-u*u);
  p[i]=r*s*Math.cos(a);p[i+1]=Math.abs(r*u*0.7)+WY+0.5;p[i+2]=r*s*Math.sin(a);},dustVS,pointFS,1.2,3,pick('uTime','uPx'),true);
await pointsObj(9000,(p,i)=>{const arm=Math.floor(rnd()*3);p[i]=arm*TAU/3+(rnd()+rnd()+rnd()-1.5)*0.55;p[i+1]=rnd();p[i+2]=rnd();},
  discVS,pointFS,0.7,4,pick('uTime','uPx','uBurst'),true);
await pointsObj(16000,(p,i)=>{p[i]=rnd()*TAU;p[i+1]=rnd();p[i+2]=rnd()*TAU;},
  flowVS,pointFS,1.7,5,{...flowU,uPal:{value:1},uRho:{value:V2(0.58,1.55)}},true);
groups[1].kind='flow';groups[2].kind='glint';groups[3].kind='soft';groups[5].kind='soft';groups[6].kind='flow';
const WAKE={value:0};
for(let i=0;i<2;i++){
  await pointsObj(3600,(p,j)=>{p[j]=rnd();p[j+1]=rnd()*TAU;p[j+2]=0;},wakeVS,pointFS,1.5,6,
    {...pick('uTime','uFC','uFS','uPx','uNight'),...DU[i],uWake:WAKE},false);
  groups[groups.length-1].kind='wake';
}

/* post chain */
const sceneRT=renderer.createTarget(4,4,{depth:true,samples:4});
const LV=6, down=[], up=[];
for(let i=0;i<LV;i++){
  down.push(renderer.createTarget(4,4));
  if(i<LV-1)up.push(renderer.createTarget(4,4));
  await yieldWithinBudget();
}
const godRT=renderer.createTarget(4,4);
const pm=(fs,uniforms)=>SM({vertexShader:quadVS,fragmentShader:fs,uniforms,depthTest:false,depthWrite:false});
const mBright=pm(brightFS,{tD:{value:null},uTexel:{value:V2()},uNight:U.uNight});
const mDown=pm(downFS,{tD:{value:null},uTexel:{value:V2()}});
const mUp=pm(upFS,{tD:{value:null},tAdd:{value:null},uTexel:{value:V2()}});
const mGod=pm(godFS,{tD:{value:null},uSun:{value:V2(0.5,0.8)},uAspect:U.uAspect,uNight:U.uNight});
const mFinal=pm(finalFS,{tScene:{value:sceneRT.texture},tBloom:{value:up[0].texture},tGod:{value:godRT.texture},
  uTime:U.uTime,uFade:{value:0},uFlash:{value:0},uRes:{value:V2()},uGodI:{value:1},uNight:U.uNight});
const pass=(m,rt)=>renderer.pass(m,rt,camera);

let quality=1, BW=4, BH=4;
function resize(){
  const w=root.clientWidth,h=root.clientHeight;
  if(w<2||h<2) return;
  const pr=Math.min(window.devicePixelRatio||1,2,Math.sqrt(4.4e6/(w*h)))*quality;
  renderer.setPixelRatio(pr); renderer.setSize(w,h);
  BW=Math.max(2,Math.floor(w*pr)); BH=Math.max(2,Math.floor(h*pr));
  sceneRT.setSize(BW,BH);
  let mw=BW,mh=BH;
  for(let i=0;i<LV;i++){mw=Math.max(2,mw>>1);mh=Math.max(2,mh>>1);down[i].setSize(mw,mh);if(i<LV-1)up[i].setSize(mw,mh);}
  godRT.setSize(down[1].width,down[1].height);
  camera.aspect=w/h; camera.updateProjectionMatrix();
  U.uAspect.value=w/h; U.uPx.value=BH/(2*TANF); mFinal.uniforms.uRes.value.set(BW,BH);
}
listen(window,'resize',()=>{resize();drawStill();}); resize();
listen(canvas,'webglcontextlost',e=>{e.preventDefault();});
listen(canvas,'webglcontextrestored',()=>{ S.energy=0; resize(); });

/* ------------------------------------------------------------------ */
/*  Interaction                                                        */
/* ------------------------------------------------------------------ */
const POLMIN=0.35,POLMAX=1.80,RMIN=4,RMAX=42;
const S={tgt:[0,-2.1,0],az:-0.22,pol:1.42,rad:44,azT:-0.06,polT:1.50,radT:33,mx:0,my:0,pmx:0,pmy:0,hasPtr:false,
  energy:0,lastInput:-10,ts:1,pulseT:-1,spinVel:0.10,flash:0,night:night,nightV:night?1:0,
  roll:[0,Math.PI]};
const ptrs=new Map(); let downInfo=null, pinch=0;
const touched=()=>{S.lastInput=performance.now()/1000;root.classList.add('touched');};
const setMouse=e=>{S.mx=e.clientX/root.clientWidth*2-1;S.my=-(e.clientY/root.clientHeight*2-1);S.hasPtr=true;};
listen(canvas,'pointerdown',e=>{
  canvas.setPointerCapture?.(e.pointerId); ptrs.set(e.pointerId,[e.clientX,e.clientY]); setMouse(e);
  downInfo={t:performance.now(),moved:0}; canvas.classList.add('drag'); touched();
  if(ptrs.size===2){const a=[...ptrs.values()];pinch=Math.hypot(a[0][0]-a[1][0],a[0][1]-a[1][1]);}
});
listen(canvas,'pointermove',e=>{
  setMouse(e);
  const p=ptrs.get(e.pointerId);
  if(p){
    const dx=e.clientX-p[0],dy=e.clientY-p[1]; p[0]=e.clientX;p[1]=e.clientY;
    if(downInfo)downInfo.moved+=Math.abs(dx)+Math.abs(dy);
    if(ptrs.size===1){S.azT-=dx*0.0055;S.polT=clamp(S.polT-dy*0.0055,POLMIN,POLMAX);touched();}
    else if(ptrs.size===2){const a=[...ptrs.values()],d=Math.hypot(a[0][0]-a[1][0],a[0][1]-a[1][1]);
      if(pinch>0)S.radT=clamp(S.radT*pinch/d,RMIN,RMAX);pinch=d;}
  }
  S.energy=Math.min(1,S.energy+0.08);
});
const release=e=>{
  if(!ptrs.has(e.pointerId))return; ptrs.delete(e.pointerId);
  if(ptrs.size===0){canvas.classList.remove('drag');
    if(downInfo&&downInfo.moved<7&&performance.now()-downInfo.t<400){ if(!onTap())pulse(); }
    downInfo=null; if(e.pointerType==='touch')S.hasPtr=false;}
};
listen(canvas,'pointerup',release); listen(canvas,'pointercancel',release);
listen(canvas,'pointerleave',()=>{if(ptrs.size===0)S.hasPtr=false;});
listen(canvas,'wheel',e=>{e.preventDefault();S.radT=clamp(S.radT*Math.exp(e.deltaY*0.0011),RMIN,RMAX);touched();},{passive:false});
listen(canvas,'contextmenu',e=>e.preventDefault());
const modeBtn=root.querySelector('#mode'), modeTxt=root.querySelector('#modeTxt');
function setNight(v){
  S.night=v; root.classList.toggle('night',v);
  try{onNight(v);}catch(e){}
  modeTxt.textContent=v?'白昼':'夜晚';
  modeBtn.setAttribute('aria-pressed',String(v));
}
setNight(S.night);
listen(modeBtn,'click',e=>{e.stopPropagation();setNight(!S.night);modeBtn.blur();});
listen(window,'keydown',e=>{
  if(disposed)return;
  if(onKey(e))return;
  if(e.key==='n'||e.key==='N')setNight(!S.night);
});
function pulse(){S.pulseT=0;S.spinVel=Math.min(S.spinVel+0.7,1.6);S.flash=1;touched();}

/* each head turns to stay upright (crown to the sky, a little toward the viewer) */
const wrapA=a=>a-TAU*Math.round(a/TAU);
function updateRoll(i,camPos,dtR,snap){
  const {C,T,D,S:Sd}=trackFrameCPU(i,HL*0.45,time);
  const toCam=norm(sub(camPos,C));
  let Wv=add([0,1,0],mul(toCam,0.40));
  Wv=sub(Wv,mul(T,dot(Wv,T)));
  if(vlen(Wv)<1e-4)return;
  const target=Math.atan2(dot(Wv,Sd),dot(Wv,D));
  const k=snap?1:1-Math.exp(-dtR*2.2);
  S.roll[i]=S.roll[i]+wrapA(target-S.roll[i])*k;
  rollU[i].value=S.roll[i];
}

/* ------------------------------------------------------------------ */
/*  Frame loop                                                         */
/* ------------------------------------------------------------------ */
let last=performance.now(),time=0,spin=SPIN0,frames=0,avgMs=16,cool=120;
/* ---------------- opening choreography ---------------- */
const CH={state:'idle',t:0,T:7.8,spd:1,k:0,form:0,reveal:0,wake:0,camRate:1.3,formed:false,onForm:null};
const H0=-(Math.max(ENT[0].L,ENT[1].L)+HL+1.5), HF=LB+0.8, VC=0.10*CIRC/TAU;
let HH=H0;
function formBurst(){S.pulseT=0;S.flash=1.15;S.energy=1;root.classList.add('formed');}
function choreo(dt){
  if(CH.state==='fly'){
    CH.t+=dt*CH.spd; const k=Math.min(1,CH.t/CH.T), e=1-Math.pow(1-k,2.2);
    HH=H0+(HF-H0-VC*CH.T)*e+VC*CH.t; CH.k=k;
    if(!CH.formed&&HH>=LB+0.3){CH.formed=true;formBurst();try{CH.onForm&&CH.onForm();}catch(err){console.warn(err);}}
    if(k>=1)CH.state='live';
  }else if(CH.state==='live'){ HH+=S.spinVel*dt*CIRC/TAU; if(HH>LB+CIRC+1)HH-=CIRC; }
  for(let i=0;i<2;i++){ENT[i].H=HH;DU[i].uHead.value=HH;const J=pathFrameCPU(ENT[i].u,time).C;DU[i].uJC.value.set(J[0],J[1],J[2]);}
  spin=ENT[0].u+HH*TAU/CIRC;
  const prog=CH.state==='idle'?0:Math.min(1,Math.max(0,(HH-H0)/(HF-H0)));
  CH.reveal+=((CH.formed?1:prog*0.9)-CH.reveal)*(1-Math.exp(-dt*2.2));
  CH.form+=((CH.formed?1:0)-CH.form)*(1-Math.exp(-dt*1.1));
  const wt=CH.state==='fly'&&!CH.formed?1:0;
  CH.wake+=(wt-CH.wake)*(1-Math.exp(-dt*(wt>CH.wake?5:0.9)));
  U.uReveal.value=CH.reveal; WAKE.value=CH.wake;
}
let running=true, rafId=0;
const ptr=[3,0,0], TY=-0.15;
const lockQ=false;
function frame(now){
  if(running) rafId=requestAnimationFrame(frame);
  if(document.hidden){last=now;return;}
  const ms=Math.max(0,now-last); last=now;   /* rAF stamps can precede the init clock → never step backwards */
  const dtR=Math.min(ms/1000,0.05);
  S.ts+=(1-S.ts)*(1-Math.exp(-dtR*3.5));
  const dt=dtR*S.ts; time+=dt;
  S.spinVel+=(0.10-S.spinVel)*(1-Math.exp(-dt*0.7));
  choreo(dt);
  S.flash*=Math.exp(-dtR*3.0);
  S.nightV+=((S.night?1:0)-S.nightV)*(1-Math.exp(-dtR*2.2));
  if(Math.abs(S.nightV-(S.night?1:0))<0.002)S.nightV=S.night?1:0;
  const nv=S.nightV;
  let pAmp=0,pPos=0,burst=0,pR=0;
  if(S.pulseT>=0){
    S.pulseT+=dt; const q=S.pulseT/2.6;
    pPos=q; pAmp=q<1?Math.sin(Math.min(q*6,1)*Math.PI/2)*(1-sstep(0.8,1,q)):0;
    burst=Math.exp(-S.pulseT*1.5)*Math.min(S.pulseT*8,1);
    pR=S.pulseT*4.2;
    if(S.pulseT>4)S.pulseT=-1;
  }
  /* camera */
  const tNow=now/1000, idle=tNow-S.lastInput;
  if(idle>4&&ptrs.size===0&&CH.state==='live')S.azT+=dtR*0.035*Math.min((idle-4)/3,1);   /* 入场时不漂移，保持构图 */
  const k=1-Math.exp(-dtR*5.0);
  S.pmx+=(S.mx-S.pmx)*k*0.5; S.pmy+=(S.my-S.pmy)*k*0.5;
  S.az+=(S.azT-S.az)*k*0.6; S.pol+=(S.polT-S.pol)*k; S.rad+=(S.radT-S.rad)*(1-Math.exp(-dtR*CH.camRate));
  const asp=root.clientWidth/root.clientHeight;
  const rad=S.rad*Math.max(1,1.05/asp)*(1-0.025*burst);
  const az=S.az-S.pmx*0.06, pol=clamp(S.pol+S.pmy*0.04,0.2,1.9);
  const tgt=S.tgt||[0,TY,0];
  const pos=add(tgt,[rad*Math.sin(pol)*Math.sin(az),rad*Math.cos(pol),rad*Math.sin(pol)*Math.cos(az)]);
  pos[1]=Math.max(pos[1],WY+0.5);
  camera.position.set(pos[0],pos[1],pos[2]); camera.lookAt(tgt[0],tgt[1],tgt[2]);
  const F=norm(sub(tgt,pos)),R=norm(cross(F,[0,1,0])),Up=cross(R,F);
  U.uCamF.value.set(F[0],F[1],F[2]);U.uCamR.value.set(R[0],R[1],R[2]);U.uCamU.value.set(Up[0],Up[1],Up[2]);
  const sd=norm(sub(STAR,pos)); U.uSunDir.value.set(sd[0],sd[1],sd[2]);
  const cd=norm(sub(CORE,pos)); U.uCoreDir.value.set(cd[0],cd[1],cd[2]);
  const lp=lerp3(STAR,CORE,nv); U.uLightPos.value.set(lp[0],lp[1],lp[2]);
  const sun=lerp3(STAR,CORE,sstep(0,1,nv)), sp=sub(sun,pos), sz=dot(sp,F);
  if(sz>0){mGod.uniforms.uSun.value.set(dot(sp,R)/(sz*TANF*asp)*0.5+0.5,dot(sp,Up)/(sz*TANF)*0.5+0.5);mFinal.uniforms.uGodI.value=1;}
  else mFinal.uniforms.uGodI.value=0;
  updateRoll(0,pos,dtR,frames===0); updateRoll(1,pos,dtR,frames===0);
  /* pointer in world (on the plane of the ∞) */
  const rd=norm(add(F,add(mul(R,S.mx*TANF*asp),mul(Up,S.my*TANF))));
  let hit=add(pos,mul(rd,rad));
  if(Math.abs(rd[2])>0.05){const t=-pos[2]/rd[2];const h=add(pos,mul(rd,t));if(t>0&&Math.hypot(h[0],h[1])<12)hit=h;}
  for(let i=0;i<3;i++)ptr[i]+=(hit[i]-ptr[i])*(1-Math.exp(-dtR*9));
  S.energy*=Math.exp(-dtR*0.9);
  const pI=S.hasPtr?0.35+0.65*S.energy:S.energy*0.3;
  U.uPointer.value.set(ptr[0],ptr[1],ptr[2]);
  U.uPointerI.value+=(pI-U.uPointerI.value)*k;
  U.uTime.value=time; U.uSpin.value=spin; U.uNight.value=nv;
  U.uPulsePos.value=pPos; U.uPulseAmp.value=pAmp; U.uBurst.value=burst; U.uPulseR.value=pR;
  U.uCore.value=(1+0.1*Math.sin(time*0.8)+1.0*burst)*(0.15+0.85*CH.reveal);
  for(const r of rings){setRot(r,time);r.u.uGain.value=r.gain*(0.12+0.88*CH.reveal);}
  for(const g of groups){
    if(g.kind==='wake'){g.gu.value=g.gain;g.o.visible=CH.wake>0.003;continue;}
    const f=g.kind==='flow'?0.10+0.90*CH.reveal:g.kind==='glint'?CH.form*CH.form:g.kind==='soft'?0.30+0.70*CH.reveal:1;
    const w=(g.night?nv:1-nv)*f; g.gu.value=g.gain*w; g.o.visible=w>0.004;}
  coreMesh.visible=nv>0.004;
  mFinal.uniforms.uFade.value=sstep(0.1,2.6,tNow-t0);
  mFinal.uniforms.uFlash.value=S.flash;

  /* render */
  renderer.setRenderTarget(sceneRT); renderer.render(scene,camera);
  mBright.uniforms.tD.value=sceneRT.texture; mBright.uniforms.uTexel.value.set(1/BW,1/BH); pass(mBright,down[0]);
  for(let i=1;i<LV;i++){mDown.uniforms.tD.value=down[i-1].texture;mDown.uniforms.uTexel.value.set(1/down[i-1].width,1/down[i-1].height);pass(mDown,down[i]);}
  let low=down[LV-1];
  for(let i=LV-2;i>=0;i--){mUp.uniforms.tD.value=low.texture;mUp.uniforms.tAdd.value=down[i].texture;
    mUp.uniforms.uTexel.value.set(1/low.width,1/low.height);pass(mUp,up[i]);low=up[i];}
  mGod.uniforms.tD.value=down[1].texture; pass(mGod,godRT);
  pass(mFinal,null);

  frames++;
  if(running&&!lockQ&&frames>40&&ms<100){
    avgMs+=(ms-avgMs)*0.05;
    if(--cool<0){
      if(avgMs>30&&quality>0.6){quality=Math.max(0.6,quality*0.85);cool=180;avgMs=20;resize();}
      else if(avgMs<20&&quality<1){quality=Math.min(1,quality/0.85);cool=240;resize();}
    }
  }
  if(frames===2)root.classList.add('ready');
}
const t0=performance.now()/1000;
listen(document,'visibilitychange',()=>{
  if(!document.hidden){last=performance.now();avgMs=16;cool=120;resize();drawStill();}
});

function drawStill(){
  if(running)return;
  cancelAnimationFrame(rafId);
  rafId=requestAnimationFrame(now=>{last=now;frame(now);});
}
let disposed=false;
function startFly(spd=1){ if(CH.state!=='idle')return false; CH.state='fly'; CH.t=0; CH.spd=spd; S.radT=29.5; S.polT=1.50; S.azT=-0.12; return true; }
function setCam(o){ Object.assign(S,o); }
function setCamRate(r){ CH.camRate=r; }
function dispose(){ if(disposed)return; disposed=true; running=false; cancelAnimationFrame(rafId); for(const [target,type,handler,options] of listeners) target.removeEventListener(type,handler,options); try{renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();}catch(e){} }
rafId=requestAnimationFrame(frame);
return { S, CH, pulse, setNight, startFly, setCam, setCamRate, dispose };
}
