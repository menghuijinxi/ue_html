'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');

const scalar=process.argv.includes('--scalar-visibility'),staticAssembly=process.argv.includes('--static');
const testFunction=staticAssembly?'WebNaniteStaticAssemblyTest':'WebNaniteAssemblyTest';
const testGlobal=staticAssembly?'__webNaniteStaticAssemblyTest':'__webNaniteAssemblyTest';
const output=path.join(__dirname,staticAssembly?'results/nanite-assembly/static-scene':'results/nanite-assembly/skin-scene');fs.mkdirSync(output,{recursive:true});
const source=path.join(__dirname,'results/nanite-skinning/fixture/skin-source-triangles.bin');
const bytes=fs.readFileSync(source),vertices=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
assert.equal(vertices.length,2048*3*9);
const fixtures=JSON.parse(fs.readFileSync(path.join(__dirname,'results/nanite-assembly/fixture/fixtures.json'),'utf8'));
const fixture=fixtures.fixtures.find(f=>f.asset.includes(staticAssembly?'NaniteAssemblySmall.':'NaniteAssemblySkinSmall.'));
const parts=fixture.instances.map((part,index)=>{
  const data=staticAssembly?fs.readFileSync(path.join(__dirname,'results/nanite-assembly/fixture',part.part+'-source.bin')):bytes;
  return {...part,index,vertices:new Float32Array(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength))};
});
const geometries=staticAssembly?parts:[{index:-1,vertices},...parts];
const multiply=(a,b)=>Array.from({length:16},(_,i)=>[0,1,2,3].reduce((s,k)=>s+a[(i>>2)*4+k]*b[k*4+(i&3)],0));
const determinant=m=>m[0]*(m[5]*m[10]-m[6]*m[9])-m[1]*(m[4]*m[10]-m[6]*m[8])+m[2]*(m[4]*m[9]-m[5]*m[8]);
function attachment(g,bones,active){
  if(staticAssembly||!active)return g.transform;
  const skin=Array(16).fill(0);
  for(const w of g.weights){
    const weight=g.weights.length===1?1:Math.round(w.weight*255)/255;
    for(let j=0;j<16;j++)skin[j]+=bones[w.bone][j]*weight;
  }
  const m=multiply(g.transform,skin);
  const dot=(a,b)=>[0,1,2].reduce((s,j)=>s+m[a*4+j]*m[b*4+j],0);
  for(const [dst,src] of [[1,0],[2,0],[2,1]]){
    const factor=dot(dst,src)/dot(src,src);for(let j=0;j<3;j++)m[dst*4+j]-=factor*m[src*4+j];
  }
  return m;
}
function transformPart(position,normal,m){
  return {position:mul([...position,1],m).slice(0,3),
    normal:[0,1,2].map(j=>normal.reduce((s,x,r)=>s+x*m[r*4+j]/Math.hypot(...m.slice(r*4,r*4+3)),0))};
}
const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
for(let i=0;i<vertices.length;i+=9)for(let j=0;j<3;j++){
  bounds.min[j]=Math.min(bounds.min[j],vertices[i+j]);bounds.max[j]=Math.max(bounds.max[j],vertices[i+j]);
}
const sourceCenter=bounds.min.map((v,j)=>(v+bounds.max[j])/2);
const report={pass:false,scalar,staticAssembly,assembly:true,source:audit(__filename),geometry:audit(source),package:audit(path.join(__dirname,'build/nanite-browser/package.json')),tests:[],errors:[],validationFailures:[],logs:[]};
report.fixture=audit(path.join(__dirname,'results/nanite-assembly/fixture/fixtures.json'));
report.partSources=[...new Set(parts.map(part=>path.join(__dirname,'results/nanite-assembly/fixture',part.part+'-source.bin')))].filter(fs.existsSync).map(audit);
const save=()=>fs.writeFileSync(path.join(output,scalar?'browser-scalar.json':'browser.json'),JSON.stringify(report,null,2));
const float=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
const mul=(v,m)=>[0,1,2,3].map(c=>v.reduce((n,x,r)=>n+x*m[r*4+c],0));
const normalize=v=>{const length=Math.hypot(...v);return v.map(x=>x/length);};
const cross3=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
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
  globalThis.__skinningGPU={errors:[]};
  GPUAdapter.prototype.requestDevice=async function(d){
    if(scalar)d={...d,requiredFeatures:[...(d?.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
    const device=await request.call(this,d);__skinningGPU.features=[...device.features];
    device.addEventListener('uncapturederror',e=>__skinningGPU.errors.push(e.error.message));return device;
  };
}
function settings(t,e){
  const front=e.component===0,active=front&&[12,13,21].includes(t.step);
  const m=e.localToWorld,det=m[0]*(m[5]*m[10]-m[6]*m[9])-m[1]*(m[4]*m[10]-m[6]*m[8])+m[2]*(m[4]*m[9]-m[5]*m[8]);
  return {current:active?[40,25,15]:[0,0,0],previous:active?(t.step===13?[15,-10,-20]:[40,25,15]):[0,0,0],
    maximum:t.step===21?0:120,masked:front&&[11,12,13,30,31].includes(t.step),pdo:front&&t.step===11?25:0,
    oneSided:front&&[8,9].includes(t.step),reverse:det<0};
}
function quantizedWeights(weight){
  const f=Math.fround, weights=[f(1-weight),f(weight)],total=f(weights[0]+weights[1]);
  const scaled=weights.map(w=>f(f(w*255)/total)),quantized=scaled.map(Math.round);
  let remaining=255-quantized[0]-quantized[1];
  if(remaining){
    const errors=quantized.map((q,i)=>f(q-scaled[i]));
    const index=remaining>0?(errors[0]<=errors[1]?0:1):(errors[0]>errors[1]?0:1);
    quantized[index]+=remaining;
  }
  assert.equal(quantized[0]+quantized[1],255);
  return quantized.map(w=>f(w*f(1/255)));
}
function skin(position,normal,weight,bones,active){
  if(!active)return {position,normal};
  const f=Math.fround,weights=quantizedWeights(weight),p=[0,0,0],n=[0,0,0];
  for(let b=0;b<2;b++)for(let c=0;c<3;c++){
    const m=bones[b].map(f);
    const transformed=f(f(f(f(position[0]*m[c])+f(position[1]*m[4+c]))+f(position[2]*m[8+c]))+m[12+c]);
    const rotated=f(f(f(normal[0]*m[c])+f(normal[1]*m[4+c]))+f(normal[2]*m[8+c]));
    p[c]=f(p[c]+f(transformed*weights[b]));n[c]=f(n[c]+f(rotated*weights[b]));
  }
  return {position:p,normal:n};
}
// Project authored source triangles independently of the Nanite visibility,
// decoded barycentrics and material-input snapshots being tested.
function reference(t){
  const result=Array(t.width*t.height).fill(null),edge=new Uint8Array(result.length);
  for(const e of t.entries){
    // Ordinary skeletal proxies explicitly opt out of animation-size culling
    // with -1; the default CVar applies to instanced skeletal proxies at zero.
    const active=true;
    const translated=e.localToWorld.map(Math.fround);
    for(let j=0;j<3;j++)translated[12+j]=Math.fround(e.localToWorld[12+j]+t.preViewTranslation[j]);
    const projection=t.translatedWorldToClip.map(Math.fround);
    for(const geometry of geometries)for(let base=0;base<geometry.vertices.length;base+=27){
      const vertices=geometry.vertices;
      const assembly=geometry.index>=0?attachment(geometry,e.bones,active):null;
      const oldAssembly=geometry.index>=0?attachment(geometry,e.previousBones,active):null;
      const partSign=assembly?Math.sign(determinant(assembly)):1;
      const materialSlot=geometry.index<0?0:staticAssembly?(vertices[base+8]^(geometry.index>=2?1:0)):(geometry.index>=2?1:0);
      const config=settings(t,e); config.reverse=!!config.reverse!==(partSign<0);
      const original=[0,1,2].map(k=>Array.from(vertices.slice(base+k*9,base+k*9+3)));
      const sourceNormal=normalize(cross3(original[2].map((x,j)=>x-original[0][j]),original[1].map((x,j)=>x-original[0][j])));
      const offset=(v,current)=>v.map((x,j)=>{
        const d=x*current[j];return config.maximum>0?Math.min(config.maximum,Math.max(-config.maximum,d)):d;
      });
      const v=[];
      for(let k=0;k<3;k++){
        const a=Array.from(vertices.slice(base+k*9,base+k*9+9));
        const sourcePosition=a.slice(0,3).map(x=>Math.round(x*1024)/1024);
        const deformed=assembly?transformPart(sourcePosition,sourceNormal,assembly):skin(sourcePosition,sourceNormal,a[8],e.bones,active);
        const previousDeformed=oldAssembly?transformPart(sourcePosition,sourceNormal,oldAssembly):skin(sourcePosition,sourceNormal,a[8],e.previousBones,active);
        const localPosition=deformed.position;
        const normal=[0,1,2].map(j=>deformed.normal.reduce((sum,x,r)=>sum+x*e.localToWorld[r*4+j]/Math.hypot(...e.localToWorld.slice(r*4,r*4+3)),0));
        const p=mul([...localPosition,1],e.localToWorld);
        // UE 5.8's native skeletal Nanite builder omits vertex colors. Its
        // cluster attribute is white (also independently decoded by the
        // streaming oracle), so the material receives the full WPO parameter.
        const color=Array(3).fill(1);
        const delta=offset(color,config.current),prevDelta=offset(color,config.previous);
        const oldP=mul([...previousDeformed.position,1],e.previousLocalToWorld);
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
        if(config.masked&&uv[0]<.5)continue;
        let depth=b.reduce((n,a,j)=>n+a*v[j].z,0),pdoScale=1;
        if(config.pdo){
          const world=interpolate('world',4),delta=[world[0]-100000,world[1],world[2]-100000];
          const forward=config.pdo*delta[0]/Math.hypot(...delta);pdoScale=1/(1+forward*reciprocal);depth*=pdoScale;
        }
        if(depth<0||depth>1)continue;
        if(!result[i]||depth>result[i].depth)result[i]={component:e.component,depth,previousClip:interpolate('old',4),uv,vertices:v,pdo:!!config.pdo,pdoScale,
          normal:normalize(interpolate('normal',3)),area,oneSided:config.oneSided,partSign,part:geometry.index,materialSlot};
      }
    }
  }
  return {pixels:result,edge};
}
function verify(t){
  assert.equal(t.localHierarchy,t.step!==34,'exercise both global and local hierarchy queues');
  assert.equal(t.rejected,0);assert(t.hasVelocity);assert.equal(t.cameraCut,t.step===27);
  assert.equal(t.pixels.length,t.width*t.height*12);assert.equal(t.gbuffer.length,t.width*t.height*28);
  if(t.step!==26&&t.step!==27){assert.equal(t.jitterX,0);assert.equal(t.jitterY,0);}
  else assert(Math.abs(t.jitterX)+Math.abs(t.jitterY)>0,'temporal jitter must be active');
  assert.deepEqual(t.entries.map(e=>e.component).sort(),[14,16].includes(t.step)?[1]:[0,1]);
  for(const e of t.entries){
    assert.equal(e.skinning,!staticAssembly,'ordinary proxy deformation mode');
    assert.equal(e.assemblyCount,4);assert(e.queueCapacity>0);
    assert.equal(t['state'+e.component][1],0,'assembly traversal and packing must not overflow');
    assert(t['state'+e.component][0]>0);
    assert.equal(e.animationMinScreenSize,-1,'ordinary skeletal animation ignores the default size threshold');
    assert.equal(e.bones.length,2);assert.equal(e.previousBones.length,2);
    assert(e.poseFrame<=t.renderFrame);
    // Assemblies retain all five fixture material slots. The native primitive
    // proxy scans GetUsedMaterials(), including unused WPO slots, when setting
    // AnyMaterialHasWorldPositionOffset(). Pixel displacement below is checked
    // independently against the two slots actually referenced by geometry.
    assert.equal(e.evaluateWPO,e.component!==0||![30,31].includes(t.step),'native assembly proxy WPO state');
    if(e.component===0){
      if(t.step>=22&&t.step<=26)assert.equal(e.poseFrame,t.renderFrame,'authored pose must belong to the sampled render frame');
    }
  }
  const expected=reference(t),byInstance=new Map(t.entries.map(e=>[e.instance,e])),clipToWorld=inverse(t.worldToClip);
  const counts={};let compared=0,edgeSamples=0,maxDepthError=0,maxVelocityError=0,maxVelocityDepthError=0,moving=0;
  let normalSamples=0,maxNormalCosineError=0,cameraReconstructed=0,maxCameraReprojectionError=0;
  let subpixelChecks=0,maxDepthResidual=0,maxDepthIntervalWidth=0,maxVelocityDepthTolerance=0;
  for(let i=0;i<expected.pixels.length;i++){
    const p=i*12,g=i*28,id=t.pixels[p],owner=id?byInstance.get(t.pixels[p+8])?.component:-1,ref=expected.pixels[i];
    assert(owner===-1||owner===0||owner===1);
    if(id){
      assert.equal(t.pixels[p+1],t.pixels[p+10],'WPO depth must reach the real scene');
      assert.equal(t.gbuffer[g],id);assert.equal(t.gbuffer[g+1],t.pixels[p+1]);assert.equal(t.pixels[p+2]&1,1);
      counts[owner]=(counts[owner]||0)+1;
      const record=(id>>>8)-1,assemblyIndex=t.visibleRecords[record*3+2]&0xffffff;
      const entry=byInstance.get(t.pixels[p+8]);
      assert(assemblyIndex===0xffffff||assemblyIndex>=entry.assemblyBase&&assemblyIndex<entry.assemblyBase+12&&((assemblyIndex-entry.assemblyBase)%3)===0);
      if(!expected.edge[i]&&ref){
        assert.equal(assemblyIndex,ref.part<0?0xffffff:entry.assemblyBase+ref.part*3,'visible record selects the authored assembly instance');
      }
      const slot=(ref?.materialSlot??0)^(owner===0&&t.step===33?1:0);
      const color=owner===0?(slot?[.05,.15,.8]:[.8,.04,.03]):(slot?[.7,.6,.04]:[.1,.7,.2]);
      if(!expected.edge[i]&&ref)for(let j=0;j<3;j++)assert(Math.abs(srgb(float(t.gbuffer[g+16+j]))*255-Math.round(srgb(color[j])*255))<=.5,`assembly material slot step ${t.step}, pixel ${i}, slot ${slot}`);
    }
    if(expected.edge[i]){edgeSamples++;continue;}
    assert.equal(owner,ref?.component??-1,`step ${t.step} pixel ${i} independent assembly coverage`);
    if(!ref)continue;
    compared++;const depth=float(t.pixels[p+1]),de=Math.abs(depth-ref.depth);maxDepthError=Math.max(maxDepthError,de);
    const depthTolerance=t.perspective?1e-7:1.2e-7;
    let residual=de;
    if(de>=depthTolerance){
      const interval=depthInterval(ref.vertices,(i%t.width)*8+.5,Math.floor(i/t.width)*8+.5);
      // PDO preserves the uncertainty of the hardware raster depth. Its
      // positive camera-ray offset scales both ends of that depth interval.
      interval.min*=ref.pdoScale;interval.max*=ref.pdoScale;
      residual=Math.max(0,interval.min-depth,depth-interval.max);subpixelChecks++;
      maxDepthIntervalWidth=Math.max(maxDepthIntervalWidth,interval.max-interval.min);
    }
    maxDepthResidual=Math.max(maxDepthResidual,residual);
    assert(residual<depthTolerance,`step ${t.step} pixel ${i} skinning depth residual ${residual}, raw ${de}`);
    const entry=byInstance.get(t.pixels[p+8]),matrix=entry.localToWorld;
    const determinant=matrix[0]*(matrix[5]*matrix[10]-matrix[6]*matrix[9])-matrix[1]*(matrix[4]*matrix[10]-matrix[6]*matrix[8])+matrix[2]*(matrix[4]*matrix[9]-matrix[5]*matrix[8]);
    // Native material facing includes the primitive determinant; a one-sided
    // material retains its authored normal even with reverse-culling enabled.
    const face=ref.oneSided?1:-Math.sign(ref.area)*Math.sign(determinant)*ref.partSign;
    const actualNormal=normalize([8,9,10].map(j=>float(t.gbuffer[g+j])*2-1));
    const normalError=1-face*ref.normal.reduce((sum,x,j)=>sum+x*actualNormal[j],0);
    assert(normalError<.003,`skinning normal step ${t.step} pixel ${i}: ${normalError}`);
    maxNormalCosineError=Math.max(maxNormalCosineError,normalError);normalSamples++;
    if((t.step!==13&&(t.step<22||t.step>26))||owner!==0)continue;
    const px=(i%t.width)*8+.5,py=Math.floor(i/t.width)*8+.5;
    let old=ref.previousClip;
    if(ref.part>=0&&t.step!==13){
      // Native assembly velocity reprojects the rasterized surface through
      // current/previous part transforms. Unlike blended skinning it does not
      // interpolate the previous triangle. Keep authored transforms as the
      // oracle; the independently checked raster depth anchors reprojection.
      const ndc=[px/t.viewWidth*2-1,1-py/t.viewHeight*2,depth,1];
      const homogeneous=mul(ndc,clipToWorld),world=homogeneous.map(v=>v/homogeneous[3]);
      const check=mul(world,t.worldToClip);
      const error=Math.max(...ndc.slice(0,3).map((v,j)=>Math.abs(v-check[j]/check[3])));
      maxCameraReprojectionError=Math.max(maxCameraReprojectionError,error);assert(error<1e-8);
      const component=mul(world,inverse(entry.localToWorld));
      const part=parts[ref.part],local=mul(component,inverse(attachment(part,entry.bones,true)));
      const previous=mul(local,attachment(part,entry.previousBones,true));
      old=mul(mul(previous,entry.previousLocalToWorld),t.previousWorldToClip);cameraReconstructed++;
    }
    const velocity=[px/t.viewWidth*2-1-t.jitterX-old[0]/old[3]+t.previousJitterX,
      1-py/t.viewHeight*2-t.jitterY-old[1]/old[3]+t.previousJitterY];
    const actual=[float(t.pixels[p+4]),float(t.pixels[p+5])];
    assert(t.pixels[p+9]&32);assert(actual.some(v=>v!==0),'skinning must emit velocity');
    const decoded=actual.map(v=>{const linear=(v-32767/65535)/.2495;return Math.sign(linear)*linear*linear*.5;});
    for(let j=0;j<2;j++){
      const error=Math.abs(decoded[j]-velocity[j]);maxVelocityError=Math.max(maxVelocityError,error);
      const tolerance=2e-6+Math.sqrt(2*Math.abs(velocity[j]))/(.2495*65535)*.51;
      assert(error<tolerance,`skinning velocity pixel ${i}/${j}: ${decoded[j]} versus ${velocity[j]}`);
    }
    const words=[float(t.pixels[p+6]),float(t.pixels[p+7])].map(v=>Math.round(v*65535));
    const dz=float(((words[0]<<16)|(words[1]&65532))>>>0),error=Math.abs(dz-(depth-old[2]/old[3]));
    // Projection, interpolation and depth subtraction each quantize to float32.
    // Keep the absolute error as evidence as well as the per-sample bound.
    const zTolerance=Math.max(1e-7,3*Math.max(floatULP(depth),floatULP(old[2]/old[3])));
    maxVelocityDepthTolerance=Math.max(maxVelocityDepthTolerance,zTolerance);
    maxVelocityDepthError=Math.max(maxVelocityDepthError,error);assert(error<zTolerance,'skinning depth velocity');
    if(Math.hypot(...velocity)>1e-5)moving++;
  }
  assert(compared>200);assert(edgeSamples<expected.pixels.length*.05);
  if(t.step===13||t.step>=22&&t.step<=26)assert(moving>20&&moving>Math.min(100,(counts[0]||0)*.8));
  if(![8,14,16,19].includes(t.step))assert((counts[0]||0)>20,'deformed surface coverage');
  if(t.step===8){
    assert.equal(expected.pixels.filter(p=>p?.component===0).length,0);
    assert.equal(counts[0]||0,0);
  }
  return {counts,compared,edgeSamples,maxDepthError,maxDepthResidual,subpixelChecks,maxDepthIntervalWidth,
    maxVelocityError,maxVelocityDepthError,maxVelocityDepthTolerance,moving,normalSamples,maxNormalCosineError,cameraReconstructed,maxCameraReprojectionError};
}
module.exports={reference,verify,skin,quantizedWeights,attachment,fixture};
if(require.main===module)(async()=>{let browser,page,owner;try{
  browser=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{channel:'msedge',headless:true,viewport:{width:960,height:640}});
  await browser.route('**/web-engine-worker.js?*',async route=>{const response=await route.fetch();await route.fulfill({response,body:'('+observe.toString()+')('+JSON.stringify(scalar)+');\n'+await response.text()});});
  await browser.route('**/nanite-browser/index.html',async route=>{const response=await route.fetch();await route.fulfill({response,
    body:(await response.text()).replace('"-WebNaniteRootPages=2"','"-WebNaniteRootPages=512","-WebNaniteStreamingPages=12","-WebNaniteScene"')});});
  page=await browser.newPage();page.on('console',m=>{const s=m.text();report.logs.push(s);if(/GPU validation:|Fatal error:|Assertion failed|DeviceLost|P3_WEB_COMPUTE_PIPELINE_REJECT|Failed to create (?:compute|graphics) pipeline/.test(s))report.errors.push(s);});
  page.on('pageerror',e=>report.errors.push(e.stack));
  await page.goto('http://127.0.0.1:8765/build/nanite-browser/index.html');
  await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=120,null,{timeout:180000});
  assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
  owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
  for(let step=1;step<=34;step++){
    assert.equal(await page.evaluate(([name,s])=>__webEngineRPC(name,s),[testFunction,step]),1);
    let test;const start=Date.now();
    do{
      await page.waitForTimeout(100);assert.deepEqual(report.errors,[]);
      assert.equal(await page.evaluate(name=>__webEngineRPC(name,0),testFunction),1);
      test=await owner.evaluate(name=>globalThis[name]||null,testGlobal);
    }while((!test||test.step!==step)&&Date.now()-start<90000);
    assert(test&&test.step===step);report.tests.push(test);
    assert(test.entries.every(e=>Array.isArray(e.previousLocalToWorld)&&Array.isArray(e.localWPOExtent)),
      'Runtime must contain the current WPO motion and culling diagnostics');
    try{test.validation=verify(test);}catch(error){test.validationFailure=error.stack;report.validationFailures.push({step,failure:error.stack});}
    const screenshot=path.join(output,`${scalar?'scalar':'packed'}-${step}.png`);
    await page.locator('canvas').screenshot({path:screenshot});test.image=audit(screenshot);
    console.log({step,...test.validation,failure:test.validationFailure});save();
  }
  assert.equal(await page.evaluate(name=>__webEngineRPC(name,35),testFunction),1);
  const cleanup=await page.evaluate(()=>globalThis.__webEngineFrames);
  await page.waitForFunction(f=>globalThis.__webEngineFrames>f+20,cleanup,{timeout:30000});
  report.rhi=await owner.evaluate(()=>globalThis.__webOptimizationRHI);
  assert(report.rhi.asyncPrecacheRequested>100);assert.equal(report.rhi.asyncPrecacheRequested,report.rhi.asyncPrecacheCompleted);
  assert.equal(report.rhi.asyncPrecacheFailed||0,0);
  report.gpu=await owner.evaluate(()=>globalThis.__skinningGPU);
  assert.equal(report.gpu.features.includes('atomic-vec2u-min-max'),!scalar);assert.deepEqual(report.gpu.errors,[]);
  report.frames=await page.evaluate(()=>globalThis.__webEngineFrames);assert.deepEqual(report.errors,[]);
  assert.deepEqual(report.validationFailures,[],'Every assembly scenario must satisfy its independent oracle');report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;}
finally{save();if(browser)await browser.close();}})();
