#pragma once
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <numeric>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif
using Clock = std::chrono::steady_clock;
inline double elapsed(Clock::time_point t) {return std::chrono::duration<double,std::milli>(Clock::now()-t).count();}
inline void require(bool ok,const char* what){if(ok)return;
#ifdef __EMSCRIPTEN__
 EM_ASM({postMessage({error:UTF8ToString($0)});},what);std::abort();
#else
 throw std::runtime_error(what);
#endif
}
inline std::string quote(const std::string& s){std::string o="\"";for(char c:s){if(c=='"'||c=='\\')o+='\\';if(c=='\n')o+="\\n";else if(c=='\r')o+="\\r";else o+=c;}return o+'"';}
inline void array(std::ostream& o,const std::vector<double>& v){o<<'[';for(size_t i=0;i<v.size();i++){if(i)o<<',';o<<v[i];}o<<']';}
inline void stats(std::ostream& o,const std::vector<double>& v){auto a=v;std::sort(a.begin(),a.end());require(!a.empty(),"empty samples");o<<"{\"meanMs\":"<<std::accumulate(a.begin(),a.end(),0.)/a.size()<<",\"medianMs\":"<<a[a.size()/2]<<",\"p95Ms\":"<<a[size_t((a.size()-1)*.95)]<<",\"samplesMs\":";array(o,v);o<<'}';}
inline std::vector<float> vertexData(){std::vector<float> a(64*64);for(unsigned i=0;i<64;i++){auto p=a.data()+64*i;p[0]=-1;p[1]=-1;p[2]=3;p[3]=-1;p[4]=-1;p[5]=3;}return a;}
inline std::vector<uint16_t> indexData(){std::vector<uint16_t> a(64*128);for(unsigned i=0;i<64;i++){a[i*128]=0;a[i*128+1]=1;a[i*128+2]=2;}return a;}
inline std::vector<float> colorData(){std::vector<float> a(64*64);for(unsigned i=0;i<64;i++){a[i*64]=float((i*3+17)%256)/255;a[i*64+1]=float((i*5+31)%256)/255;a[i*64+2]=float((i*7+47)%256)/255;a[i*64+3]=1;}return a;}
inline void verifyPixel(const uint8_t* p,unsigned mode,unsigned n){unsigned k=(mode==1||mode==2)?(n-1)%64:0;unsigned b[4]={(k*3+17)%256,(k*5+31)%256,(k*7+47)%256,255};if((mode==1||mode==2)&&((n-1)&1))std::swap(b[0],b[2]);for(unsigned c=0;c<4;c++)require(std::abs(int(p[c])-int(b[c]))<=1,"rendered pixel mismatch");}
constexpr const char* wgsl=R"(
struct Color { value:vec4f }
@group(0) @binding(0) var<uniform> color:Color;
@vertex fn vs(@location(0) xy:vec2f)->@builtin(position) vec4f{return vec4f(xy,0.0,1.0);}
@fragment fn fs0()->@location(0) vec4f{return color.value;}
@fragment fn fs1()->@location(0) vec4f{return color.value.bgra;}
)";
constexpr const char* hlsl=R"(
cbuffer Color:register(b0){float4 color;}
float4 vs(float2 xy:POSITION):SV_Position{return float4(xy,0,1);}
float4 fs0():SV_Target{return color;}
float4 fs1():SV_Target{return color.bgra;}
)";
// Both backends record one frame per list, submit once, and bound in-flight
// work to three frames. Drain time is kept outside CPU encoding measurements.
template<class GPU> std::string benchmark(GPU& g,unsigned warm=12,unsigned frames=60){
 std::ostringstream o;o<<std::setprecision(12)<<"{\"backend\":"<<quote(g.name())<<",\"adapter\":"<<quote(g.adapterName)<<",\"warmupFrames\":"<<warm<<",\"measuredFrames\":"<<frames<<",\"inFlight\":3,\"cases\":[";
 bool first=true;
 for(unsigned n:{1000u,3200u,10000u})for(unsigned mode=0;mode<4;mode++){
  double build=g.prepare(mode,n);std::vector<double> setup,draw,close,submit,gpu;
  for(unsigned j=0;j<warm;j++){auto a=g.begin(j%3,false);g.emit(mode,n);g.end();g.submit();if(j%3==2)g.wait();}g.wait();
  auto wall=Clock::now();
  for(unsigned j=0;j<frames;j++){
   auto t=Clock::now();g.begin(j%3,false);double s=elapsed(t);t=Clock::now();g.emit(mode,n);double d=elapsed(t);t=Clock::now();g.end();double c=elapsed(t);t=Clock::now();g.submit();double q=elapsed(t);
   setup.push_back(s);draw.push_back(d);close.push_back(c);submit.push_back(q);if(j%3==2)g.wait();
  }g.wait();double wallMs=elapsed(wall);
  // GPU timestamps are an extra run, never mixed with normal CPU samples.
  for(unsigned j=0;j<10;j++){g.begin(0,true);g.emit(mode,n);g.end();g.submit();g.wait();gpu.push_back(g.gpuMilliseconds());}
  g.verify(mode,n);g.checkErrors();
  if(!first)o<<',';first=false;
  o<<"{\"draws\":"<<n<<",\"mode\":"<<mode<<",\"bundleBuildMs\":"<<build<<",\"wallMs\":"<<wallMs<<",\"batch3WallMsPerFrame\":"<<wallMs/frames<<",\"setup\":";stats(o,setup);o<<",\"drawLoop\":";stats(o,draw);o<<",\"finish\":";stats(o,close);o<<",\"submit\":";stats(o,submit);o<<",\"gpu\":";stats(o,gpu);o<<",\"outputVerified\":true}";
  std::cerr<<g.name()<<" mode="<<mode<<" draws="<<n<<" done\n";
 }o<<"],\"pass\":true}";return o.str();
}
