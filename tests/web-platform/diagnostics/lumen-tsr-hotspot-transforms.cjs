'use strict';

function transform(source, mode, subgroups = true) {
  const facts = {lumenLoads: 0, tsrVotes: 0, lumenCachedLoads: 0};
  if ((mode & 4) && source.includes('var View_GlobalDistanceFieldPageTableTexture : texture_3d<u32>')) {
    source = source.replace(/textureLoad\(View_GlobalDistanceFieldPageTableTexture, ([^\r\n]+?), 0i\)\.x\b/g,
      (whole, coord) => {
        ++facts.lumenCachedLoads;
        return `WebLumenCachedPage(vec3<i32>(${coord}))`;
      });
    if (facts.lumenCachedLoads) source += `
var<private> WebLumenPageValid : bool = false;
var<private> WebLumenPageCoord : vec3<i32>;
var<private> WebLumenPageValue : u32;
fn WebLumenCachedPage(coord : vec3<i32>) -> u32 {
  if (!WebLumenPageValid || any(coord != WebLumenPageCoord)) {
    WebLumenPageValue = textureLoad(View_GlobalDistanceFieldPageTableTexture, coord, 0i).x;
    WebLumenPageCoord = coord;
    WebLumenPageValid = true;
  }
  return WebLumenPageValue;
}
`;
  }
  if (mode & 1) {
    source = source.replace(/let (\w+) = (textureLoad\(View_GlobalDistanceFieldPageTableTexture,[^\r\n]+?\)\.x);(?=\r?\n[\s\S]{0,240}?if \(\(\(\1 < 4294967295u\) & \((\w+) < View\.View_GlobalDistanceFieldMipTransition\)\)\))/g,
      (whole, page, load, mip) => {
        ++facts.lumenLoads;
        return `var ${page} = 4294967295u;\nif (${mip} < View.View_GlobalDistanceFieldMipTransition) {\n${page} = ${load};\n}`;
      });
  }
  if ((mode & 2) && subgroups && source.includes('WebTSRAnyThreadResult')) {
    source = source.replace(/_ = atomicOr\(&\(SharedAtomic\), select\(0u, 1u, (\w+)\)\);/g, (whole, predicate) => {
      const name = 'WebTSRSubgroupVote' + facts.tsrVotes++;
      return `let ${name} = subgroupAny(${predicate});\nif (subgroupElect()) {\n_ = atomicOr(&(SharedAtomic), select(0u, 1u, ${name}));\n}`;
    });
    if (facts.tsrVotes && !source.includes('enable subgroups;')) source = 'enable subgroups;\n' + source;
  }
  return {source, facts};
}

module.exports = transform;
