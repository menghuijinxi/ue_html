'use strict';
const assert = require('node:assert/strict');

function performanceModes({optimizationsOff = false, occlusion, clock, rhiwake} = {}) {
  const explicit = [occlusion, clock, rhiwake].some(value => value !== undefined);
  assert(!optimizationsOff || !explicit, 'Choose rollback or individual performance switches');
  const modes = {
    occlusion: occlusion ?? (optimizationsOff ? 'control' : 'history'),
    clock: clock ?? 'owner',
    rhiwake: rhiwake ?? (optimizationsOff ? 'channel' : 'priority'),
  };
  for (const [name, choices] of Object.entries({
    occlusion: ['control', 'history'], clock: ['owner', 'local'], rhiwake: ['channel', 'priority'],
  })) assert(choices.includes(modes[name]), 'Invalid performance mode: ' + name);
  // Emit the clock explicitly so archived packages with a local default also roll back.
  return {modes, query: '?' + new URLSearchParams(modes)};
}

module.exports = {performanceModes};
