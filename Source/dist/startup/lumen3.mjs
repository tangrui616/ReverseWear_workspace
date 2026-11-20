export const L3=(()=>{
'use strict';
class Vec2{constructor(x=0,y=0){this.x=x;this.y=y;}set(x,y){this.x=x;this.y=y;return this;}}
class Vec3{constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}}
class Geometry{
  constructor(){this.attrs={};this.index=null;this.count=0;this.vaos=new Map();}
  setAttribute(name,array,size){this.attrs[name]={array,size,buf:null};if(!this.index)this.count=array.length/size;return this;}
  setIndex(array){this.index={array,buf:null};this.count=array.length;return this;}
}
const NoBlend=0,PremulBlend=1,AddBlend=2;
class Material{
  constructor(o={}){
    this.vertexShader=o.vertexShader; this.fragmentShader=o.fragmentShader; this.uniforms=o.uniforms||{};
    this.blending=o.blending??NoBlend; this.depthTest=o.depthTest??true; this.depthWrite=o.depthWrite??true;
    this.transparent=o.transparent??(this.blending!==NoBlend);
  }
}
class Mesh{constructor(g,m){this.geometry=g;this.material=m;this.renderOrder=0;this.visible=true;this.isPoints=false;}}
class Points extends Mesh{constructor(g,m){super(g,m);this.isPoints=true;}}
class Scene{constructor(){this.children=[];}add(o){this.children.push(o);return o;}}
class PerspectiveCamera{
  constructor(fov=50,aspect=1,near=0.1,far=100){
    this.fov=fov;this.aspect=aspect;this.near=near;this.far=far;this.position=new Vec3();
    this.projectionMatrix=new Float32Array(16);this.viewMatrix=new Float32Array(16);
    this.viewMatrix[0]=this.viewMatrix[5]=this.viewMatrix[10]=this.viewMatrix[15]=1;this.updateProjectionMatrix();
  }
  updateProjectionMatrix(){
    const f=1/Math.tan(this.fov*Math.PI/360),nf=1/(this.near-this.far),m=this.projectionMatrix;
    m.fill(0);m[0]=f/this.aspect;m[5]=f;m[10]=(this.far+this.near)*nf;m[11]=-1;m[14]=2*this.far*this.near*nf;
  }
  lookAt(tx,ty,tz){
    const e=this.position;let zx=e.x-tx,zy=e.y-ty,zz=e.z-tz,l=Math.hypot(zx,zy,zz)||1;zx/=l;zy/=l;zz/=l;
    let xx=zz,xy=0,xz=-zx;l=Math.hypot(xx,xz)||1;xx/=l;xz/=l;          // x = up × z  (up = +Y)
    const yx=zy*xz-zz*xy,yy=zz*xx-zx*xz,yz=zx*xy-zy*xx;
    const v=this.viewMatrix;
    v[0]=xx;v[1]=yx;v[2]=zx;v[3]=0; v[4]=xy;v[5]=yy;v[6]=zy;v[7]=0; v[8]=xz;v[9]=yz;v[10]=zz;v[11]=0;
    v[12]=-(xx*e.x+xy*e.y+xz*e.z);v[13]=-(yx*e.x+yy*e.y+yz*e.z);v[14]=-(zx*e.x+zy*e.y+zz*e.z);v[15]=1;
  }
}
class RenderTarget{
  constructor(r,w,h,o={}){this.r=r;this.o=o;this.width=0;this.height=0;this.texture={glTex:null};this.fbo=null;this.msFbo=null;this.rbs=[];this.setSize(w,h);}
  setSize(w,h){
    w=Math.max(1,w|0);h=Math.max(1,h|0); if(w===this.width&&h===this.height)return;
    this.width=w;this.height=h;this._dispose();this._create(this.o.samples||0);
  }
  _dispose(){
    const gl=this.r.gl;
    if(this.texture.glTex)gl.deleteTexture(this.texture.glTex);
    if(this.fbo)gl.deleteFramebuffer(this.fbo); if(this.msFbo)gl.deleteFramebuffer(this.msFbo);
    for(const b of this.rbs)gl.deleteRenderbuffer(b); this.rbs=[];this.fbo=this.msFbo=null;this.texture.glTex=null;
  }
  _rb(fmt,samples){
    const gl=this.r.gl,b=gl.createRenderbuffer();gl.bindRenderbuffer(gl.RENDERBUFFER,b);
    if(samples>1)gl.renderbufferStorageMultisample(gl.RENDERBUFFER,samples,fmt,this.width,this.height);
    else gl.renderbufferStorage(gl.RENDERBUFFER,fmt,this.width,this.height);
    this.rbs.push(b);return b;
  }
  _create(samples){
    const gl=this.r.gl,hf=this.r.cbf,w=this.width,h=this.height;
    const ifmt=hf?gl.RGBA16F:gl.RGBA8,type=hf?gl.HALF_FLOAT:gl.UNSIGNED_BYTE;
    const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);
    gl.texImage2D(gl.TEXTURE_2D,0,ifmt,w,h,0,gl.RGBA,type,null);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    this.texture.glTex=t;
    this.fbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);
    samples=Math.min(samples,this.r.maxSamples);
    if(samples>1){
      this.msFbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,this.msFbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.RENDERBUFFER,this._rb(ifmt,samples));
      if(this.o.depth)gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,this._rb(gl.DEPTH_COMPONENT24,samples));
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE){this._dispose();this._create(0);return;}
    }else if(this.o.depth){
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,this._rb(gl.DEPTH_COMPONENT24,0));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }
}
const VPRE=`#version 300 es
precision highp float; precision highp int;
#define attribute in
#define varying out
#define texture2D texture
uniform mat4 projectionMatrix; uniform mat4 viewMatrix; uniform vec3 cameraPosition;
in vec3 position; in vec3 normal;
`;
const FPRE=`#version 300 es
precision highp float; precision highp int;
#define varying in
#define texture2D texture
#define gl_FragColor pc_fragColor
out highp vec4 pc_fragColor;
uniform mat4 viewMatrix; uniform vec3 cameraPosition;
`;
class Renderer{
  constructor({canvas}){
    const gl=canvas.getContext('webgl2',{alpha:false,antialias:false,depth:true,stencil:false,premultipliedAlpha:false,powerPreference:'high-performance'});
    if(!gl)throw new Error('WebGL2 unavailable');
    this.gl=gl;this.domElement=canvas;
    this.cbf=!!(gl.getExtension('EXT_color_buffer_float')||gl.getExtension('EXT_color_buffer_half_float'));
    gl.getExtension('OES_texture_float_linear');
    this.maxSamples=gl.getParameter(gl.MAX_SAMPLES)||0;
    this.programs=new Map();this.pid=0;this.pixelRatio=1;this.target=null;
    this.st={blend:-1,dt:null,dw:null,prog:null};
    this.quad=new Geometry().setAttribute('position',new Float32Array([-1,-1,0, 3,-1,0, -1,3,0]),3);
    gl.depthFunc(gl.LEQUAL);gl.disable(gl.CULL_FACE);
  }
  setPixelRatio(p){this.pixelRatio=p;}
  setSize(w,h){const c=this.domElement;c.width=Math.max(1,Math.floor(w*this.pixelRatio));c.height=Math.max(1,Math.floor(h*this.pixelRatio));c.style.width=w+'px';c.style.height=h+'px';}
  createTarget(w,h,o){return new RenderTarget(this,w,h,o);}
  setRenderTarget(t){this.target=t;}
  _compile(type,src){
    const gl=this.gl,s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){
      const log=gl.getShaderInfoLog(s);
      console.error(log+'\n'+src.split('\n').map((l,i)=>(i+1)+': '+l).join('\n'));throw new Error('shader compile failed: '+log);
    }
    return s;
  }
  _program(m){
    const key=m.vertexShader+'\u0000'+m.fragmentShader;let p=this.programs.get(key);if(p)return p;
    const gl=this.gl,pr=gl.createProgram();
    gl.attachShader(pr,this._compile(gl.VERTEX_SHADER,VPRE+m.vertexShader));
    gl.attachShader(pr,this._compile(gl.FRAGMENT_SHADER,FPRE+m.fragmentShader));
    gl.linkProgram(pr);
    if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw new Error('link failed: '+gl.getProgramInfoLog(pr));
    const uniforms=[],attribs=[];
    for(let i=0,n=gl.getProgramParameter(pr,gl.ACTIVE_UNIFORMS);i<n;i++){
      const a=gl.getActiveUniform(pr,i);uniforms.push({name:a.name.replace(/\[0\]$/,''),type:a.type,size:a.size,loc:gl.getUniformLocation(pr,a.name),buf:null});
    }
    for(let i=0,n=gl.getProgramParameter(pr,gl.ACTIVE_ATTRIBUTES);i<n;i++){
      const a=gl.getActiveAttrib(pr,i);attribs.push({name:a.name,loc:gl.getAttribLocation(pr,a.name)});
    }
    p={prog:pr,uniforms,attribs,id:++this.pid};this.programs.set(key,p);return p;
  }
  _flat(u,v,n){
    const len=u.size*n; if(!u.buf||u.buf.length!==len)u.buf=new Float32Array(len);
    const b=u.buf; for(let i=0;i<u.size&&i<v.length;i++){const e=v[i];b[i*n]=e.x;b[i*n+1]=e.y;if(n>2)b[i*n+2]=e.z;}
    return b;
  }
  _uniforms(p,m,cam){
    const gl=this.gl;let unit=0;
    for(const u of p.uniforms){
      let v;
      if(u.name==='projectionMatrix')v=cam.projectionMatrix;else if(u.name==='viewMatrix')v=cam.viewMatrix;
      else if(u.name==='cameraPosition')v=cam.position;
      else{const e=m.uniforms[u.name];if(!e)continue;v=e.value;}
      if(v==null)continue;
      switch(u.type){
        case gl.FLOAT: if(u.size>1)gl.uniform1fv(u.loc,v);else gl.uniform1f(u.loc,v);break;
        case gl.FLOAT_VEC2: if(Array.isArray(v))gl.uniform2fv(u.loc,this._flat(u,v,2));else gl.uniform2f(u.loc,v.x,v.y);break;
        case gl.FLOAT_VEC3: if(Array.isArray(v))gl.uniform3fv(u.loc,this._flat(u,v,3));else gl.uniform3f(u.loc,v.x,v.y,v.z);break;
        case gl.FLOAT_VEC4: gl.uniform4f(u.loc,v.x,v.y,v.z,v.w);break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc,false,v);break;
        case gl.SAMPLER_2D: {const t=v.glTex||(v.texture&&v.texture.glTex);gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,t);gl.uniform1i(u.loc,unit);unit++;break;}
        case gl.INT: case gl.BOOL: gl.uniform1i(u.loc,v|0);break;
      }
    }
  }
  _vao(g,p){
    let v=g.vaos.get(p.id);if(v)return v;
    const gl=this.gl;v=gl.createVertexArray();gl.bindVertexArray(v);
    for(const a of p.attribs){
      const at=g.attrs[a.name];if(!at||a.loc<0)continue;
      if(!at.buf){at.buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,at.buf);gl.bufferData(gl.ARRAY_BUFFER,at.array,gl.STATIC_DRAW);}
      else gl.bindBuffer(gl.ARRAY_BUFFER,at.buf);
      gl.enableVertexAttribArray(a.loc);gl.vertexAttribPointer(a.loc,at.size,gl.FLOAT,false,0,0);
    }
    if(g.index){
      if(!g.index.buf){g.index.buf=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,g.index.buf);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,g.index.array,gl.STATIC_DRAW);}
      else gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,g.index.buf);
    }
    gl.bindVertexArray(null);g.vaos.set(p.id,v);return v;
  }
  _state(m){
    const gl=this.gl,s=this.st;
    if(s.blend!==m.blending){
      s.blend=m.blending;
      if(m.blending===NoBlend)gl.disable(gl.BLEND);
      else{gl.enable(gl.BLEND);
        if(m.blending===PremulBlend)gl.blendFuncSeparate(gl.ONE,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
        else gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE,gl.ONE,gl.ONE);}
    }
    if(s.dt!==m.depthTest){s.dt=m.depthTest;m.depthTest?gl.enable(gl.DEPTH_TEST):gl.disable(gl.DEPTH_TEST);}
    if(s.dw!==m.depthWrite){s.dw=m.depthWrite;gl.depthMask(m.depthWrite);}
  }
  _draw(o,cam){
    const gl=this.gl,m=o.material,g=o.geometry,p=this._program(m);
    if(this.st.prog!==p){gl.useProgram(p.prog);this.st.prog=p;}
    this._uniforms(p,m,cam);this._state(m);
    gl.bindVertexArray(this._vao(g,p));
    if(o.isPoints)gl.drawArrays(gl.POINTS,0,g.count);
    else if(g.index)gl.drawElements(gl.TRIANGLES,g.count,g.index.array instanceof Uint32Array?gl.UNSIGNED_INT:gl.UNSIGNED_SHORT,0);
    else gl.drawArrays(gl.TRIANGLES,0,g.count);
    gl.bindVertexArray(null);
  }
  _bind(t){
    const gl=this.gl;
    if(!t){gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,this.domElement.width,this.domElement.height);}
    else{gl.bindFramebuffer(gl.FRAMEBUFFER,t.msFbo||t.fbo);gl.viewport(0,0,t.width,t.height);}
  }
  _resolve(t){
    if(!t||!t.msFbo)return;const gl=this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,t.msFbo);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,t.fbo);
    gl.blitFramebuffer(0,0,t.width,t.height,0,0,t.width,t.height,gl.COLOR_BUFFER_BIT,gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }
  render(scene,cam){
    const gl=this.gl;this._bind(this.target);
    if(this.st.dw!==true){this.st.dw=true;gl.depthMask(true);}
    gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    const vis=scene.children.filter(o=>o.visible),by=(a,b)=>a.renderOrder-b.renderOrder;
    for(const o of vis.filter(o=>!o.material.transparent).sort(by))this._draw(o,cam);
    for(const o of vis.filter(o=>o.material.transparent).sort(by))this._draw(o,cam);
    this._resolve(this.target);
  }
  /* full-screen pass (one triangle) */
  pass(m,t,cam){this._bind(t);this._draw({material:m,geometry:this.quad,isPoints:false},cam);this._resolve(t);}
}
return {Vec2,Vec3,Geometry,Material,Mesh,Points,Scene,PerspectiveCamera,Renderer,NoBlend,PremulBlend,AddBlend};
})();
