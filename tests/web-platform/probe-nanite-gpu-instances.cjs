'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const spline=require('./nanite-spline-reference.cjs');
const scalar=process.argv.includes('--scalar-visibility');
const stress=process.argv.includes('--phase-stress');
const unbounded=process.argv.includes('--unbounded-phase');
const writerBarrier=process.argv.includes('--writer-barrier');
const validateBindings=process.argv.includes('--validate-bindings');
const writerFinal=process.argv.includes('--writer-final');
const recreateEveryFrame=process.argv.includes('--recreate-every-frame');
const legacyWriter=process.argv.includes('--legacy-writer');
const output=path.join(__dirname,'results/nanite-gpu-instances'+(recreateEveryFrame&&!legacyWriter?'/recreate':unbounded?'/unbounded-phase':stress?'/phase-stress':''));fs.mkdirSync(output,{recursive:true});
const source=path.join(__dirname,'results/nanite-programmable/wpo-source-triangles.bin');
const bytes=fs.readFileSync(source),vertices=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
assert.equal(vertices.length,2048*3*8);
const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
for(let i=0;i<vertices.length;i+=8)for(let j=0;j<3;j++){
  bounds.min[j]=Math.min(bounds.min[j],vertices[i+j]);bounds.max[j]=Math.max(bounds.max[j],vertices[i+j]);
}
const sourceCenter=bounds.min.map((v,j)=>(v+bounds.max[j])/2);
const report={pass:false,scalar,phaseStress:stress,unboundedPhase:unbounded,writerBarrier,writerFinal,validateBindings,recreateEveryFrame,legacyWriter,source:audit(__filename),geometry:audit(source),geometryReference:audit(require.resolve('./nanite-spline-reference.cjs')),package:audit(path.join(__dirname,'build/nanite-browser/package.json')),tests:[],errors:[],validationFailures:[],logs:[]};
const save=()=>fs.writeFileSync(path.join(output,scalar?'browser-scalar.json':'browser.json'),JSON.stringify(report,null,2));
const float=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
const normalize=v=>{const length=Math.hypot(...v);return v.map(x=>x/length);};
const cross3=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const mul=(v,m)=>[0,1,2,3].map(c=>v.reduce((n,x,r)=>n+x*m[r*4+c],0));
function inverse(m){
  const a=Array.from({length:4},(_,r)=>[...m.slice(r*4,r*4+4),...[0,1,2,3].map(c=>r===c?1:0)]);
  for(let c=0;c<4;c++){
    let pivot=c;for(let r=c+1;r<4;r++)if(Math.abs(a[r][c])>Math.abs(a[pivot][c]))pivot=r;
    [a[pivot],a[c]]=[a[c],a[pivot]];const d=a[c][c];assert(Math.abs(d)>1e-20);a[c]=a[c].map(v=>v/d);
    for(let r=0;r<4;r++)if(r!==c){const k=a[r][c];a[r]=a[r].map((v,j)=>v-k*a[c][j]);}
  }
  return a.flatMap(r=>r.slice(4));
}
const srgb=v=>v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055;
const floatULP=v=>2**(Math.floor(Math.log2(Math.max(Math.abs(v),2**-126)))-23);
function orthoPDO(t,depth,offset,fusedFrom=false,fusedTo=false){
  // Match the native orthographic linear-depth round trip at float precision.
  // Algebraically collapsing it to one device-depth addition loses its rounding.
  const f=Math.fround,m=f(t.translatedWorldToClip[2]),a=f(t.translatedWorldToClip[14]);
  const inverse=f(1/m),bias=f(-f(a/m)+1),z=f(depth);
  const scene=f((fusedFrom?f(z*inverse+bias):f(f(z*inverse)+bias))-1);
  const shifted=f(scene+Math.max(offset,0));
  return fusedTo?f(shifted*m+a):f(f(shifted*m)+a);
}
function depthInterval(vertices,px,py){
  let min=Infinity,max=-Infinity;
  const cross=(a,b,x,y)=>(b.x-a.x)*(y-a.y)-(b.y-a.y)*(x-a.x);
  for(const a of vertices[0].rasterChoices)for(const b of vertices[1].rasterChoices)for(const c of vertices[2].rasterChoices){
    const area=cross(a,b,c.x,c.y);if(Math.abs(area)<1e-9)continue;
    const w=[cross(b,c,px,py),cross(c,a,px,py),cross(a,b,px,py)].map(v=>v/area);
    if(w.some(v=>v<0))continue;
    const z=w.reduce((s,v,j)=>s+v*vertices[j].z,0);min=Math.min(min,z);max=Math.max(max,z);
  }
  assert(Number.isFinite(min)&&Number.isFinite(max));return {min,max};
}
function observe(scalar){
  const request=GPUAdapter.prototype.requestDevice;
  globalThis.__wpoGPU={errors:[]};
  GPUAdapter.prototype.requestDevice=async function(d){
    if(scalar)d={...d,requiredFeatures:[...(d?.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
    const device=await request.call(this,d);__wpoGPU.features=[...device.features];
    device.addEventListener('uncapturederror',e=>__wpoGPU.errors.push(e.error.message));return device;
  };
}
const matrixProduct=(a,b)=>Array.from({length:4},(_,r)=>mul(a.slice(r*4,r*4+4),b)).flat();
function localTransform(t,index,phase){
 const p=index===0?[0,0,0]:index===1?[80,-180,0]:index===2?[-60,180,0]:index===3?[20,0,180]:[20,0,-180];
 if(t.step===2)p[0]+=index===1?-140:30;
 if(t.step===15&&index===1)p[1]=2400;
 p[1]+=25*Math.sin(Math.fround(phase+index));
 const rotate=[3,12,29].includes(t.step),scale=rotate?[.7,index===1?-.8:.8,.4]:[.55,.55,.55];
 const angle=rotate?Math.fround(Math.fround(.37)+Math.fround(index*Math.fround(.2))):0;
 const a=Math.sin(angle),b=Math.cos(angle);
 return [scale[0]*b,scale[0]*a,0,0,-scale[1]*a,scale[1]*b,0,0,0,0,scale[2],0,...p,1].map(Math.fround);
}
function distanceSquared(t,e){
 const center=mul([...sourceCenter,1],e.localToWorld).slice(0,3).map((v,j)=>Math.fround(v-t.viewOrigin[j]));
 return Math.fround(center.reduce((s,v)=>Math.fround(s+Math.fround(v*v)),0));
}
function pixelEnabled(t,e){return e.component===1||![5,10].includes(t.step)||distanceSquared(t,e)<=450*450;}
function evaluateWPO(t,e){return e.component===0&&t.step>=7&&t.step!==29&&t.step!==11&&
 (t.step!==8||distanceSquared(t,e)<450*450);}
function instanceVisible(t,e){return e.component===1||!(t.step===13&&e.relativeInstance===1)&&
 (![27,28].includes(t.step)||distanceSquared(t,e)<=Math.pow(450*(t.step===28?2:1),2));}
function settings(t,e){
 if(e.component===1)return {current:[0,0,0],previous:[0,0,0],maximum:0};
 const wpo=evaluateWPO(t,e),pixel=pixelEnabled(t,e),material=t.step<=3||t.step===29?3:t.step<=6?0:t.step===12?2:1;
 return {current:wpo?[40,25,15]:[0,0,0],previous:wpo?[15,-10,-20]:[0,0,0],maximum:120,
 masked:pixel&&(material===0||material===1),pdo:pixel&&(material===0||material===1)?80:0,
 oneSided:material===2||material===3,reverse:[3,12,29].includes(t.step)&&e.relativeInstance===1};
}
function prepare(t){
 const result=structuredClone(t);
 for(const e of result.entries)if(e.component===0){
   assert(e.gpuOnly,'GPU-only data must remain GPU-owned');
   assert.deepEqual(e.localToWorld,[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],'no CPU transform mirror');
   e.localToWorld=matrixProduct(localTransform(t,e.relativeInstance,t.phase),t.primitiveLocalToWorld);
   e.previousLocalToWorld=matrixProduct(localTransform(t,e.relativeInstance,t.previousPhase),t.primitiveLocalToWorld);
 }
 return result;
}
function outsideReferenceFrustum(t,e){
  const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  const extent=evaluateWPO(t,e)?120:0;
  for(let corner=0;corner<8;corner++){
    const p=mul([...[0,1,2].map(j=>(corner&(1<<j)?bounds.max[j]:bounds.min[j])),1],e.localToWorld);
    for(let j=0;j<3;j++){lo[j]=Math.min(lo[j],p[j]-extent-1);hi[j]=Math.max(hi[j],p[j]+extent+1);}
  }
  const clips=Array.from({length:8},(_,corner)=>mul([...[0,1,2].map(j=>corner&(1<<j)?hi[j]:lo[j]),1],t.worldToClip));
  return [p=>p[0]+p[3],p=>p[3]-p[0],p=>p[1]+p[3],p=>p[3]-p[1],p=>p[2],p=>p[3]-p[2]]
    .some(plane=>clips.every(p=>plane(p)<0));
}
// Project authored source triangles independently of the Nanite visibility,
// decoded barycentrics and material-input snapshots being tested.
function reference(t){
  const result=Array(t.width*t.height).fill(null),edge=new Uint8Array(result.length);
  for(const e of t.entries){
    if(!instanceVisible(t,e)||outsideReferenceFrustum(t,e))continue;
    const translated=e.localToWorld.map(Math.fround);
    for(let j=0;j<3;j++)translated[12+j]=Math.fround(e.localToWorld[12+j]+t.preViewTranslation[j]);
    const projection=t.translatedWorldToClip.map(Math.fround);
    const splineParams=e.spline?spline.unpack(e.splineParams):null;
    for(let base=0;base<vertices.length;base+=24){
      const original=[0,1,2].map(k=>Array.from(vertices.slice(base+k*8,base+k*8+3)));
      const sourceNormal=normalize(cross3(original[2].map((x,j)=>x-original[0][j]),original[1].map((x,j)=>x-original[0][j])));
      const slot=Math.floor(base/48)%32<16?0:1,config=settings(t,e,slot);
      const offset=(v,current)=>v.map((x,j)=>{
        const d=x*current[j];return config.maximum>0?Math.min(config.maximum,Math.max(-config.maximum,d)):d;
      });
      const v=[];
      for(let k=0;k<3;k++){
        const a=Array.from(vertices.slice(base+k*8,base+k*8+8));
        const undeformed=a.slice(0,3).map(x=>Math.round(x*1024)/1024);
        const localPosition=splineParams?spline.deform(splineParams,undeformed).position:undeformed;
        const normal=[0,1,2].map(j=>sourceNormal.reduce((sum,x,r)=>sum+x*e.localToWorld[r*4+j]/Math.hypot(...e.localToWorld.slice(r*4,r*4+3)),0));
        const p=mul([...localPosition,1],e.localToWorld);
        const delta=offset(a.slice(5,8),config.current),prevDelta=offset(a.slice(5,8),config.previous);
        const oldP=mul([...localPosition,1],e.previousLocalToWorld);
        const world=p.map((x,j)=>x+(delta[j]||0)),previous=oldP.map((x,j)=>x+(prevDelta[j]||0));
        // Independent source geometry projected at the GPU's float precision.
        // Raster setup snaps screen coordinates to the 8-bit subpixel grid.
        const relative=mul([...localPosition,1],translated).map(Math.fround)
          .map((x,j)=>Math.fround(x+Math.fround(delta[j]||0)));
        const clip=mul(relative,projection).map(Math.fround),old=mul(previous,t.previousWorldToClip);
        const materialClip=mul(world,t.worldToClip);
        assert(clip[3]>0,'fixture must remain in front of the near plane');
        // Float dot products and perspective division can straddle a hardware
        // subpixel rounding boundary. Bound the arithmetic error from the source
        // operands, then retain every possible adjacent snapped vertex position.
        const unit=2**-24,gamma=8*unit/(1-8*unit),local=[...localPosition,1];
        const relativeError=[0,1,2].map(c=>gamma*(local.reduce((s,x,r)=>s+Math.abs(x*translated[r*4+c]),0)+Math.abs(delta[c])));
        const clipError=[0,1,2,3].map(c=>gamma*relative.reduce((s,x,r)=>s+Math.abs(x*projection[r*4+c]),0)+
          relativeError.reduce((s,x,r)=>s+x*Math.abs(projection[r*4+c]),0));
        const screen=[(clip[0]/clip[3]+1)*t.viewWidth/2,(1-clip[1]/clip[3])*t.viewHeight/2];
        const choices=screen.map((value,c)=>{
          const half=(c?t.viewHeight:t.viewWidth)/2,w=clip[3],ew=clipError[3];
          const error=half*(clipError[c]*w+Math.abs(clip[c])*ew)/(w*(w-ew))+unit*(Math.abs(value)+half);
          const lo=Math.round((value-error)*256),hi=Math.round((value+error)*256);
          assert(hi-lo<=1,'fixture projection uncertainty must stay within adjacent subpixel positions');
          return lo===hi?[lo/256]:[lo/256,hi/256];
        });
        const rasterChoices=choices[0].flatMap(x=>choices[1].map(y=>({x,y})));
        v.push({x:Math.round((clip[0]/clip[3]+1)*t.viewWidth/2*256)/256,
          y:Math.round((1-clip[1]/clip[3])*t.viewHeight/2*256)/256,
          z:clip[2]/clip[3],w:clip[3],uv:a.slice(3,5),world,old,normal,rasterChoices,
          material:{x:(materialClip[0]/materialClip[3]+1)*t.viewWidth/2,
            y:(1-materialClip[1]/materialClip[3])*t.viewHeight/2,w:materialClip[3]}});
      }
      const cross=(a,b,x,y)=>(b.x-a.x)*(y-a.y)-(b.y-a.y)*(x-a.x);
      const area=cross(v[0],v[1],v[2].x,v[2].y);if(Math.abs(area)<1e-9)continue;
      if(config.oneSided&&((area<0)===!!config.reverse))continue;
      const xmin=Math.max(0,Math.ceil((Math.min(...v.map(a=>a.x))-.51)/8));
      const xmax=Math.min(t.width-1,Math.floor((Math.max(...v.map(a=>a.x))-.49)/8));
      const ymin=Math.max(0,Math.ceil((Math.min(...v.map(a=>a.y))-.51)/8));
      const ymax=Math.min(t.height-1,Math.floor((Math.max(...v.map(a=>a.y))-.49)/8));
      for(let y=ymin;y<=ymax;y++)for(let x=xmin;x<=xmax;x++){
        const px=x*8+.5,py=y*8+.5,i=y*t.width+x;
        const c=[cross(v[1],v[2],px,py),cross(v[2],v[0],px,py),cross(v[0],v[1],px,py)];
        const b=c.map(a=>a/area);
        const distances=c.map((a,j)=>Math.abs(a)/Math.hypot(v[(j+2)%3].x-v[(j+1)%3].x,v[(j+2)%3].y-v[(j+1)%3].y));
        if(Math.min(...distances)<.01&&Math.min(...b)>-.005)edge[i]=1;
        if(b.some(a=>a<0))continue;
        // Nanite reconstructs material attributes analytically from the original
        // triangle. Hardware subpixel snapping applies to raster coverage/depth.
        const m=v.map(a=>a.material),ma=cross(m[0],m[1],m[2].x,m[2].y);
        const mb=[cross(m[1],m[2],px,py),cross(m[2],m[0],px,py),cross(m[0],m[1],px,py)].map(a=>a/ma);
        const reciprocal=mb.reduce((n,a,j)=>n+a/m[j].w,0),weights=mb.map((a,j)=>a/m[j].w/reciprocal);
        const interpolate=(key,n)=>Array.from({length:n},(_,j)=>weights.reduce((sum,a,k)=>sum+a*v[k][key][j],0));
        const uv=interpolate('uv',2);
        if(config.masked){const p=uv.map(a=>Math.floor((a-Math.floor(a))*8));if(((p[0]>>1)+(p[1]>>1))%2===0)continue;}
        let depth=b.reduce((n,a,j)=>n+a*v[j].z,0);
        let idealDepth=depth;
        if(config.pdo){
          const world=interpolate('world',4),delta=world.slice(0,3).map((v,j)=>v-t.viewOrigin[j]);
          if(t.perspective){const forward=config.pdo*delta[0]/Math.hypot(...delta);depth/=1+forward*reciprocal;}
          else {idealDepth=depth+config.pdo*t.translatedWorldToClip[2];depth=orthoPDO(t,depth,config.pdo);}
          if(t.perspective)idealDepth=depth;
        }
        if(depth<0||depth>1)continue;
        if(!result[i]||depth>result[i].depth)result[i]={component:e.component,instance:e.instance,depth,idealDepth,previousClip:interpolate('old',4),uv,vertices:v,pdo:!!config.pdo,
          orthoPDO:!t.perspective?(config.pdo||0):0,
          normal:normalize(interpolate('normal',3)),area,oneSided:config.oneSided};
      }
    }
  }
  return {pixels:result,edge};
}
function verify(raw){
  const t=prepare(raw);
  assert.equal(t.rejected,0);assert(t.hasVelocity);assert.equal(t.cameraCut,false);
  assert.equal(t.pixels.length,t.width*t.height*12);assert.equal(t.gbuffer.length,t.width*t.height*28);
  assert.equal(t.jitterX,0);assert.equal(t.jitterY,0);
  const frontCount=[17,19].includes(t.step)?0:t.step===21?5:t.step>=22?2:3;
  assert.equal(t.entries.filter(e=>e.component===0).length,frontCount);
  assert.equal(t.entries.filter(e=>e.component===1).length,1);
  if(frontCount)assert.equal(t.gpuInstances.length,t.gpuCount*21*4);
  if(frontCount){
    assert.equal(t.writerRenderFrame,t.renderFrame,'GPU writer must update the current render frame');
    assert.equal(t.writerFirst,t.entries.find(e=>e.component===0).instance,'GPU writer allocation');
    assert(t.entries.filter(e=>e.component===0).every(e=>e.primitive===t.writerPrimitive),'GPU writer primitive');
  }
  for(const e of t.entries)if(e.component===0){
    const base=e.relativeInstance*84,hidden=t.step===13&&e.relativeInstance===1;
    const flags=t.gpuInstances.slice(base+80,base+84);
    const reverse=[3,12,29].includes(t.step)&&e.relativeInstance===1;
    assert.deepEqual(flags,hidden?[0,0,0,0]:[+instanceVisible(t,e),+evaluateWPO(t,e),+pixelEnabled(t,e),+reverse],'independent GPU instance flags');
    if(hidden)continue;
    const translated=e.localToWorld.slice();for(let j=0;j<3;j++)translated[12+j]+=t.preViewTranslation[j];
    const expectedClip=matrixProduct(translated,t.translatedWorldToClip);
    for(let j=0;j<16;j++)assert(Math.abs(float(t.gpuInstances[base+j])-expectedClip[j])<3e-4,'GPUScene projection matrix');
  }
  const expected=reference(t),byInstance=new Map(t.entries.map(e=>[e.instance,e]));
  const counts={};let compared=0,edgeSamples=0,maxDepthError=0,maxVelocityError=0,maxVelocityDepthError=0,moving=0;
  let maxQuantizedDepthError=0,maxNativeReferenceError=0;
  let subpixelChecks=0,maxDepthResidual=0,maxDepthIntervalWidth=0,maxVelocityDepthTolerance=0;
  let normalSamples=0,maxNormalCosineError=0;
  for(let i=0;i<expected.pixels.length;i++){
    const p=i*12,g=i*28,id=t.pixels[p],owner=id?byInstance.get(t.pixels[p+8])?.component:-1,ref=expected.pixels[i];
    assert(owner===-1||owner===0||owner===1);
    if(id){
      assert.equal(t.pixels[p+1],t.pixels[p+10],'WPO depth must reach the real scene');
      assert.equal(t.gbuffer[g],id);assert.equal(t.gbuffer[g+1],t.pixels[p+1]);assert.equal(t.pixels[p+2]&1,1);
      counts[owner]=(counts[owner]||0)+1;
      const color=owner===0?[.2,.4,.7]:[.1,.7,.2];
      for(let j=0;j<3;j++)assert(Math.abs(srgb(float(t.gbuffer[g+16+j]))*255-Math.round(srgb(color[j])*255))<=.5);
    }
    if(expected.edge[i]){edgeSamples++;continue;}
    assert.equal(owner,ref?.component??-1,`step ${t.step} pixel ${i} independent WPO coverage`);
    if(!ref)continue;
    assert.equal(t.pixels[p+8],ref.instance,'independent GPU instance owner');
    const matrix=byInstance.get(ref.instance).localToWorld;
    const determinant=matrix[0]*(matrix[5]*matrix[10]-matrix[6]*matrix[9])-matrix[1]*(matrix[4]*matrix[10]-matrix[6]*matrix[8])+matrix[2]*(matrix[4]*matrix[9]-matrix[5]*matrix[8]);
    const face=ref.oneSided?1:-Math.sign(ref.area)*Math.sign(determinant);
    const actualNormal=normalize([8,9,10].map(j=>float(t.gbuffer[g+j])*2-1));
    const normalError=1-face*ref.normal.reduce((sum,x,j)=>sum+x*actualNormal[j],0);
    assert(normalError<.003,`GPU instance normal step ${t.step} pixel ${i}: ${normalError}`);
    maxNormalCosineError=Math.max(maxNormalCosineError,normalError);normalSamples++;
    compared++;const depth=float(t.pixels[p+1]),de=Math.abs(depth-ref.idealDepth);maxDepthError=Math.max(maxDepthError,de);
    maxNativeReferenceError=Math.max(maxNativeReferenceError,Math.abs(depth-ref.depth));
    const depthTolerance=t.perspective?1e-7:1.2e-7;
    // The scene attachment stores R32F. Compare its representable value to
    // the independent result rounded to that format, while retaining the raw
    // double-precision discrepancy above. In orthographic views the existing
    // two-ULP limit must not accidentally include a third fractional ULP from
    // comparing a float attachment against an unrepresentable real value.
    const quantizedError=Math.abs(depth-Math.fround(ref.depth));
    maxQuantizedDepthError=Math.max(maxQuantizedDepthError,quantizedError);
    let residual=quantizedError;
    if(quantizedError>=depthTolerance&&(!ref.pdo||!t.perspective)){
      const interval=depthInterval(ref.vertices,(i%t.width)*8+.5,Math.floor(i/t.width)*8+.5);
      // Carry the bounded subpixel interval through the native depth conversion.
      // Shader multiply/add may be contracted; retain both allowed float results.
      if(ref.orthoPDO){
        const values=[interval.min,interval.max].flatMap(z=>[false,true].flatMap(a=>[false,true].map(b=>orthoPDO(t,z,ref.orthoPDO,a,b))));
        interval.min=Math.min(...values);interval.max=Math.max(...values);
      }
      residual=Math.max(0,Math.fround(interval.min)-depth,depth-Math.fround(interval.max));subpixelChecks++;
      maxDepthIntervalWidth=Math.max(maxDepthIntervalWidth,interval.max-interval.min);
    }
    maxDepthResidual=Math.max(maxDepthResidual,residual);
    assert(residual<depthTolerance,`step ${t.step} pixel ${i} WPO depth residual ${residual}, raw ${de}`);
    if(owner!==0)continue;
    const px=(i%t.width)*8+.5,py=Math.floor(i/t.width)*8+.5;
    let old=ref.previousClip;
    if(t.step>=4&&t.step<=6){
      // Native rigid velocity unprojects the final depth, including PDO,
      // and applies the previous instance transform to that local position.
      const entry=byInstance.get(ref.instance);
      const local=mul([px/t.viewWidth*2-1,1-py/t.viewHeight*2,Math.fround(ref.depth),1],
        inverse(matrixProduct(entry.localToWorld,t.worldToClip)));
      old=mul(mul(local.map(v=>v/local[3]),entry.previousLocalToWorld),t.previousWorldToClip);
    }
    const velocity=[px/t.viewWidth*2-1-t.jitterX-old[0]/old[3]+t.previousJitterX,
      1-py/t.viewHeight*2-t.jitterY-old[1]/old[3]+t.previousJitterY];
    const actual=[float(t.pixels[p+4]),float(t.pixels[p+5])];assert(actual.some(v=>v!==0),'WPO must emit velocity');
    const decoded=actual.map(v=>{const linear=(v-32767/65535)/.2495;return Math.sign(linear)*linear*linear*.5;});
    for(let j=0;j<2;j++){
      const error=Math.abs(decoded[j]-velocity[j]);maxVelocityError=Math.max(maxVelocityError,error);
      const tolerance=2e-6+Math.sqrt(2*Math.abs(velocity[j]))/(.2495*65535)*.51;
      assert(error<tolerance,`WPO velocity pixel ${i}/${j}: ${decoded[j]} versus ${velocity[j]}`);
    }
    const words=[float(t.pixels[p+6]),float(t.pixels[p+7])].map(v=>Math.round(v*65535));
    const dz=float(((words[0]<<16)|(words[1]&65532))>>>0),error=Math.abs(dz-(depth-old[2]/old[3]));
    // Projection, interpolation and depth subtraction each quantize to float32.
    // Keep the absolute error as evidence as well as the per-sample bound.
    const zTolerance=Math.max(1e-7,3*Math.max(floatULP(depth),floatULP(old[2]/old[3])));
    maxVelocityDepthTolerance=Math.max(maxVelocityDepthTolerance,zTolerance);
    maxVelocityDepthError=Math.max(maxVelocityDepthError,error);assert(error<zTolerance,'WPO depth velocity');
    if(Math.hypot(...velocity)>1e-5)moving++;
  }
  assert(compared>200);assert(edgeSamples<expected.pixels.length*.05);
  if(![17,19].includes(t.step))assert((counts[0]||0)>20,'GPU-only surface coverage');
  return {counts,compared,edgeSamples,maxDepthError,maxNativeReferenceError,maxQuantizedDepthError,maxDepthResidual,subpixelChecks,maxDepthIntervalWidth,
    maxVelocityError,maxVelocityDepthError,maxVelocityDepthTolerance,moving,normalSamples,maxNormalCosineError};
}
module.exports={reference:t=>reference(prepare(t)),verify};
if(require.main===module)(async()=>{let browser,page,owner;try{
  browser=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{channel:'msedge',headless:true,viewport:{width:960,height:640}});
  await browser.route('**/web-engine-worker.js?*',async route=>{const response=await route.fetch();await route.fulfill({response,body:'('+observe.toString()+')('+JSON.stringify(scalar)+');\n'+await response.text()});});
  await browser.route('**/nanite-browser/index.html',async route=>{const response=await route.fetch();await route.fulfill({response,
    body:(await response.text()).replace('"-WebNaniteRootPages=2"','"-WebNaniteRootPages=128","-WebNaniteStreamingPages=12","-WebNaniteScene"')});});
  page=await browser.newPage();page.on('console',m=>{const s=m.text();report.logs.push(s);if(/GPU validation:|Fatal error:|Assertion failed|DeviceLost/.test(s))report.errors.push(s);});
  page.on('pageerror',e=>report.errors.push(e.stack));
  await page.goto('http://127.0.0.1:8765/build/nanite-browser/index.html');
  await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=120,null,{timeout:180000});
  assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
  owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
  if(validateBindings)assert.equal(await page.evaluate(()=>__webEngineRPC('WebBindingCacheTest',1)),1);
  if(stress)assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteGPUInstancesTest',-1)),1);
  if(unbounded)assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteGPUInstancesTest',-2)),1);
  if(writerBarrier)assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteGPUInstancesTest',-3)),1);
  if(writerFinal)assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteGPUInstancesTest',-4)),1);
  if(recreateEveryFrame)assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteGPUInstancesTest',-5)),1);
  if(legacyWriter)assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteGPUInstancesTest',-6)),1);
  for(let step=1;step<=29;step++){
    assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteGPUInstancesTest',s),step),1);
    let test;const start=Date.now();
    do{
      await page.waitForTimeout(100);assert.deepEqual(report.errors,[]);
      assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteGPUInstancesTest',0)),1);
      test=await owner.evaluate(()=>globalThis.__webNaniteGPUInstancesTest||null);
    }while((!test||test.step!==step)&&Date.now()-start<90000);
    assert(test&&test.step===step);report.tests.push(test);
    if(stress&&step===7)assert.equal(test.phase,Math.fround(103.97400665283203),'stress input must reach the GPU writer');
    assert(test.entries.every(e=>Array.isArray(e.previousLocalToWorld)&&Array.isArray(e.localWPOExtent)),
      'Runtime must contain the current WPO motion and culling diagnostics');
    try{test.validation=verify(test);}catch(error){test.validationFailure=error.stack;report.validationFailures.push({step,failure:error.stack});}
    if(test.validationFailure&&process.argv.includes('--stop-on-failure'))throw Error(test.validationFailure);
    const screenshot=path.join(output,`${scalar?'scalar':'packed'}-${step}.png`);
    await page.locator('canvas').screenshot({path:screenshot});test.image=audit(screenshot);
    console.log({step,...test.validation,failure:test.validationFailure});save();
  }
  assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteGPUInstancesTest',30)),1);
  const cleanup=await page.evaluate(()=>globalThis.__webEngineFrames);
  await page.waitForFunction(f=>globalThis.__webEngineFrames>f+20,cleanup,{timeout:30000});
  report.rhi=await owner.evaluate(()=>globalThis.__webOptimizationRHI);
  assert(report.rhi.asyncPrecacheRequested>100);assert.equal(report.rhi.asyncPrecacheRequested,report.rhi.asyncPrecacheCompleted);
  assert.equal(report.rhi.asyncPrecacheFailed||0,0);
  report.gpu=await owner.evaluate(()=>globalThis.__wpoGPU);
  assert.equal(report.gpu.features.includes('atomic-vec2u-min-max'),!scalar);assert.deepEqual(report.gpu.errors,[]);
  report.frames=await page.evaluate(()=>globalThis.__webEngineFrames);assert.deepEqual(report.errors,[]);
  assert.deepEqual(report.validationFailures,[],'Every GPU instance scenario must satisfy its independent oracle');report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;}
finally{save();if(browser)await browser.close();}})();
