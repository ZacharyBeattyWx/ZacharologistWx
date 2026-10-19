const test=require('node:test');const assert=require('node:assert/strict');
const {threatResult,activeGeometry,productCount}=require('../scripts/homepage-national-monitoring.js');
test('a successful empty SPC product is not interpreted as zero probability',()=>{assert.deepEqual(threatResult({features:[]}),{status:'not-outlined',percent:null});});
test('SPC national maximum accepts either supported property shape',()=>{assert.deepEqual(threatResult({features:[{properties:{dn:5}},{properties:{dn:15}},{attributes:{dn:10}}]}),{status:'outlined',percent:15});});
test('SPC feed failure or a malformed nonempty product is not described as no risk',()=>{assert.throws(()=>threatResult({error:{message:'upstream'}}));assert.throws(()=>threatResult({features:[{properties:{dn:null}}]}));});
test('alert map excludes expired geometries and missing polygons',()=>{const now=Date.now(),geometry={type:'Polygon',coordinates:[]};assert.equal(activeGeometry([{geometry,properties:{ends:new Date(now+10000).toISOString()}},{geometry,properties:{ends:new Date(now-10000).toISOString()}},{geometry:null,properties:{}}],now).length,1);});
test('map product count deduplicates multiple polygons for one alert',()=>{assert.equal(productCount([{properties:{cap_id:'one'}},{properties:{cap_id:'one'}},{properties:{cap_id:'two'}}]),2);});
