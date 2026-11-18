import json, pathlib, collections, sys
folder=pathlib.Path(sys.argv[1]); report=json.loads((folder/'report.json').read_text())
data=json.loads((folder/'trace.json').read_text()); events=data['traceEvents']
marks=[e for e in events if e.get('name')=='villa-low-begin']
profiles={}
for e in events:
    if e.get('name') not in ('Profile','ProfileChunk'): continue
    key=(e.get('pid'),e.get('id'))
    p=profiles.setdefault(key,{'pid':e['pid'],'tid':e['tid'],'nodes':{},'samples':[],'time':None})
    d=e.get('args',{}).get('data',{})
    if 'startTime' in d: p['time']=d['startTime']
    cp=d.get('cpuProfile',{})
    for n in cp.get('nodes',[]): p['nodes'][n['id']]=n
    samples=cp.get('samples',[]); deltas=d.get('timeDeltas',cp.get('timeDeltas',[]))
    for n,delta in zip(samples,deltas):
        if p['time'] is None: continue
        p['time']+=delta; p['samples'].append((p['time'],n,delta))
def summarize(p,start,end):
    parents={}; names={}
    for i,n in p['nodes'].items():
        names[i]=n.get('callFrame',{}).get('functionName') or '(anonymous)'
        if 'parent' in n: parents[i]=n['parent']
        for c in n.get('children',[]): parents[c]=i
    self=collections.Counter(); inclusive=collections.Counter();stacks=collections.Counter();count=0
    for t,n,us in p['samples']:
        if not start<=t<=end:continue
        count+=1;self[names.get(n,str(n))]+=us
        stack=[];seen=set()
        while n is not None and n not in seen:
            seen.add(n);stack.append(names.get(n,str(n)));n=parents.get(n)
        stacks['\n'.join(stack[:16])]+=us
        for name in set(stack):inclusive[name]+=us
    rank=lambda c:[{'name':n,'ms':v/1000} for n,v in c.most_common(18)]
    allnames='\n'.join(names.values());role='Game' if 'EngineFrame(' in allnames else 'RHI' if 'FRHIThread::WebPump' in allnames else 'Render' if 'RenderingThreadMain' in allnames or 'FRenderingThread::Run' in allnames else 'other'
    return {'pid':p['pid'],'tid':p['tid'],'role':role,'samples':count,'self':rank(self),'inclusive':rank(inclusive),'hotStacks':rank(stacks)[:3]}
out={'profiles':len(profiles),'events':len(events),'longFrames':[],'gpuCompiles':[]}
for phase,mark in zip(report['phases'],marks):
    offset=mark['ts']-mark['args']['data']['startTime']*1000
    for long in phase['long']:
        if long['ms']<=100:continue
        f=next(f for f in phase['data']['frames'] if f['frame']==long['frame'])
        end=offset+f['time']*1000;start=end-long['ms']*1000
        selected=[]
        for e in events:
            if e.get('ph')!='X' or e.get('dur',0)<20000:continue
            if e['ts']<end and e['ts']+e['dur']>start:
                selected.append({k:e[k] for k in ['name','pid','tid','ts','dur','args'] if k in e})
        out['longFrames'].append({'phase':phase['name'],'frame':long,'traceStart':start,'traceEnd':end,'profiles':[s for p in profiles.values() if (s:=summarize(p,start,end))['samples']],'events':selected})
out['gpuCompiles']=[{k:e[k] for k in ['name','pid','tid','ts','dur','args'] if k in e} for e in events if e.get('name') in ('DeviceBase::APICreateRenderPipeline','CompileShaderDXC') and e.get('dur',0)>20000]
(folder/'trace-attribution.json').write_text(json.dumps(out,ensure_ascii=False,indent=2))
print(json.dumps({'profiles':len(profiles),'events':len(events),'longFrames':[{'phase':f['phase'],'frame':f['frame']['frame'],'ms':f['frame']['ms'],'profiles':[(p['role'],p['samples'],p['inclusive'][:8]) for p in f['profiles'] if p['role']!='other'],'events':sorted(f['events'],key=lambda e:e['dur'],reverse=True)[:3]} for f in out['longFrames']],'gpuCompiles':out['gpuCompiles']},ensure_ascii=False))
