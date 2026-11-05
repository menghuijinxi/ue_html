'use strict';
const assert=require('node:assert/strict'),install=require('./web-owner-lookahead.cjs');
let seq=0;const owner=new Map(),hooks=[];
const target={requestAnimationFrame:cb=>{owner.set(++seq,cb);return seq},cancelAnimationFrame:id=>owner.delete(id)};
install(target,hooks);
const pulse=(id,time)=>{const cb=owner.get(id);owner.delete(id);cb?.(time)};
let delivered=[];
hooks[0]();hooks[0]();assert.equal(owner.size,1,'at most one reserved owner request');
const a=target.requestAnimationFrame(t=>delivered.push(t));assert.equal(owner.size,1);
assert.deepEqual(delivered,[]);pulse(a,10);assert.deepEqual(delivered,[10]);
hooks[0]();pulse(seq,20); // owner permission arrived before next callback registration
const b=target.requestAnimationFrame(t=>delivered.push(t));assert.equal(owner.size,1);
assert.deepEqual(delivered,[10],'stale owner permit must not execute a callback');
pulse(b,30);assert.deepEqual(delivered,[10,30]);
hooks[0]();const c=target.requestAnimationFrame(()=>assert.fail('cancelled callback'));
target.cancelAnimationFrame(c);pulse(c,40);assert.equal(owner.size,0);
hooks[0]();target.cancelAnimationFrame(999);assert.equal(owner.size,0,'cancellation drops speculative request');
console.log('Owner lookahead: one reserved request, owner-only delivery, stale permits and cancellation passed');
