'use strict';
self.addEventListener('unhandledrejection',e=>postMessage({error:e.reason?.stack||String(e.reason)}));
var Module={locateFile:name=>'build/draw-api/'+name,
  printErr:message=>postMessage({progress:message}),
  onAbort:message=>postMessage({error:String(message)})};
importScripts('build/draw-api/draw-wasm.js');
