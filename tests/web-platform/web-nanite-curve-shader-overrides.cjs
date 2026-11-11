'use strict';
module.exports=require('./overlays/nanite-curves-shaders.json').map(r=>[r.relative.slice('Shaders/'.length),r.hunks]);
