#include "WebOcclusionBounds.h"
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>

struct V { double x,y,z; V operator+(V b)const{return{x+b.x,y+b.y,z+b.z};}
 V operator*(double s)const{return{x*s,y*s,z*s};} };
double dot(V a,V b){return a.x*b.x+a.y*b.y+a.z*b.z;}
double length(V a){return std::sqrt(dot(a,a));}
V unit(V a){return a*(1/length(a));}
uint64_t seed=0x9e3779b97f4a7c15ULL;
double random01(){seed^=seed>>12;seed^=seed<<25;seed^=seed>>27;return double((seed*2685821657736338717ULL)>>11)*(1.0/9007199254740992.0);}
V randomDirection(){return unit({random01()*2-1,random01()*2-1,random01()*2-1});}
bool may(V t,double tr,V c,double cr){return UE::WebOcclusion::MayAffectTarget(t.x,t.y,t.z,tr,c.x,c.y,c.z,cr);}
void require(bool value,const char* reason){if(!value){std::fprintf(stderr,"%s\n",reason);std::exit(1);}}

int main(){
 require(may({10,0,0},1,{5,0,0},1),"foreground sphere");
 require(!may({10,0,0},1,{20,0,0},1),"sphere beyond target");
 require(!may({10,0,0},1,{0,5,0},1),"disjoint directions");
 require(may({10,0,0},1,{0,0,0},1),"camera inside changed bounds");
 require(may({0,0,0},1,{10,0,0},1),"camera inside target bounds");
 require(may({10,0,0},1,{5,0,0},std::numeric_limits<double>::quiet_NaN()),"invalid bounds must stay conservative");
 require(may({10,0,0},1,{5,0,0},-1),"negative radius must stay conservative");
 uint32_t intersections=0,excluded=0,constructed=0;
 for(uint32_t i=0;i<200000;++i){
  const double scale=std::pow(10.0,random01()*12-5);
  const V target=randomDirection()*(scale*(1+random01()*100));
  const double tr=scale*(.01+random01()*4);
  const V point=target+randomDirection()*(tr*std::cbrt(random01()));
  const double end=length(point);const V ray=unit(point);
  V changed;double cr;
  if(i%2){
   // Put an actual occluder around a point on the finite camera-to-target ray.
   // This constructs intersections independently of the angular bound.
   cr=scale*(.01+random01()*2);
   changed=ray*(end*random01())+randomDirection()*(cr*.9);
   ++constructed;require(may(target,tr,changed,cr),"constructed blocker was rejected");
  }else{changed=randomDirection()*(scale*(1+random01()*150));cr=scale*(.01+random01()*6);}
  const bool potential=may(target,tr,changed,cr);if(!potential)++excluded;
  // Independent segment/sphere intersection (quadratic roots).
  const double projection=dot(ray,changed), discriminant=projection*projection-dot(changed,changed)+cr*cr;
  if(discriminant>=0){const double radius=std::sqrt(discriminant),near=projection-radius,far=projection+radius;
   if(far>=0&&near<=end){++intersections;require(potential,"intersecting camera-to-target segment was rejected");}}
 }
 require(excluded>50000&&intersections>=constructed,"meaningful visible and rejected populations");
 std::printf("{\"pass\":true,\"cases\":200007,\"constructed\":%u,\"intersections\":%u,\"excluded\":%u}\n",constructed,intersections,excluded);
}
