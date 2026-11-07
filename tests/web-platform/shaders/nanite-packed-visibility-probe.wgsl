enable atomic_vec2u_min_max;

@group(0) @binding(0) var<storage, read> candidates: array<vec4u>;
@group(0) @binding(1) var<storage, read_write> pixels: array<atomic<vec2u>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) tid: vec3u) {
  if (tid.x >= arrayLength(&candidates)) {
    return;
  }
  let candidate = candidates[tid.x];
  atomicStoreMax(&pixels[candidate.z], candidate.xy);
}
