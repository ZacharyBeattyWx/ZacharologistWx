const test=require('node:test');const assert=require('node:assert/strict');
const data=require('../scripts/homepage-newsroom.js');
const now=Date.now();
const alert=(event,id=event,expires=new Date(now+3600000).toISOString())=>({id,properties:{event,expires,areaDesc:'Test county'}});
test('winter products include watches and current cold-weather names',()=>{
  for(const name of ['Winter Storm Watch','Snow Squall Warning','Extreme Cold Watch','Extreme Cold Warning','Cold Weather Advisory','Freeze Watch','Freeze Warning','Frost Advisory','Winter Weather Advisory'])assert.equal(data.alertCategory(name),'winter',name);
});
test('flood products have one category instead of duplicate storm counts',()=>{
  assert.equal(data.alertCategory('Flash Flood Warning'),'hydro');
  assert.equal(data.alertCategory('Coastal Flood Advisory'),'hydro');
  const alerts=[alert('Flash Flood Warning')];assert.equal(data.filteredAlerts(alerts,'storm',now).length,0);assert.equal(data.filteredAlerts(alerts,'hydro',now).length,1);
});
test('all includes products that previously fell through the category lists',()=>{
  const alerts=['Wind Advisory','High Wind Watch','Dense Fog Advisory','Heat Advisory','Small Craft Advisory'].map(name=>alert(name));
  assert.equal(data.filteredAlerts(alerts,'all',now).length,5);assert.equal(data.filteredAlerts(alerts,'other',now).length,5);
});
test('expired products and duplicate IDs are not counted',()=>{
  assert.equal(data.filteredAlerts([alert('Winter Storm Watch','same'),alert('Winter Storm Watch','same'),alert('Tornado Warning','old',new Date(now-1).toISOString())],'all',now).length,1);
});
test('tornado, severe and flash flood warnings sort ahead of other products',()=>{
  const values=['Winter Storm Watch','Flood Advisory','Flash Flood Warning','Tornado Warning','Severe Thunderstorm Warning'].map(name=>alert(name)).sort((a,b)=>data.alertPriority(a)-data.alertPriority(b));
  assert.deepEqual(values.slice(0,3).map(a=>a.properties.event),['Tornado Warning','Severe Thunderstorm Warning','Flash Flood Warning']);
});
