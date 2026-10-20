import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const products = [
  ...[94,98,99].map((code,i)=>({name:`outlook-rainfall-day${i+1}.gif`,source:`https://www.wpc.ncep.noaa.gov/qpf/${code}ewbg.gif`})),
  ...[1,2,3].map(day=>({name:`outlook-winter-day${day}.gif`,source:`https://www.wpc.ncep.noaa.gov/wwd/day${day}_psnow_gt_04.gif`}))
];
async function download(product) {
  for(let attempt=0;attempt<3;attempt++) {
    try {
      const response=await fetch(product.source,{signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error(`${product.name}: HTTP ${response.status}`);
      const data=Buffer.from(await response.arrayBuffer());
      if(!['GIF87a','GIF89a'].includes(data.subarray(0,6).toString())||data.length<1000||data.length>2000000)throw new Error(`${product.name}: invalid official GIF`);
      return {...product,data,sourceLastModified:response.headers.get('last-modified')};
    }catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,1000*(attempt+1)));}
  }
}
const flag=process.argv.indexOf('--output'),directory=flag>=0?process.argv[flag+1]:'weather-outlook-build';
// Validate the entire set before writing or replacing published objects.
const results=await Promise.all(products.map(download));
await mkdir(directory,{recursive:true});
const manifest={fetchedAt:new Date().toISOString(),source:'NOAA / NWS / WPC',products:{}};
for(const item of results) {
  await writeFile(join(directory,item.name),item.data);
  manifest.products[item.name]={source:item.source,sourceLastModified:item.sourceLastModified,bytes:item.data.length,sha256:createHash('sha256').update(item.data).digest('hex')};
}
await writeFile(join(directory,'outlook-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`Validated ${results.length} official outlook graphics.`);
