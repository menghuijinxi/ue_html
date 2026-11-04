'use strict';
self.addEventListener('unhandledrejection',e=>postMessage({error:e.reason?.stack||String(e.reason)}));
const variant=new URL(self.location.href).searchParams.get('variant');
if(!['scalar','simd'].includes(variant))throw Error('Invalid isolation variant');
const script=new URL('build/rhi-isolation/isolation-'+variant+'.js',self.location.href).href;
var Module={mainScriptUrlOrBlob:script,locateFile:name=>new URL('build/rhi-isolation/'+name,self.location.href).href,
 printErr:progress=>postMessage({progress}),onAbort:error=>postMessage({error:String(error)})};
importScripts(script);
