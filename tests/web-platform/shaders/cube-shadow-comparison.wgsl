@group(0) @binding(0) var shadow: texture_depth_cube;
@group(0) @binding(1) var shadowSampler: sampler_comparison;

@fragment
fn main() -> @location(0) vec4f {
    return vec4f(textureSampleCompareLevel(shadow, shadowSampler, vec3f(1, 0, 0), 0.5));
}
