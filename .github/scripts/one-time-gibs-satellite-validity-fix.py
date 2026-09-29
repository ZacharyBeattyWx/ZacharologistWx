from pathlib import Path

path = Path("weather-viewer.html")
text = path.read_text(encoding="utf-8")

replacements = [
    (
        'const width=probe?320:context.width;',
        'const width=probe?480:context.width;',
        'larger GIBS probe image',
    ),
    (
        'FORMAT:"image/png",TRANSPARENT:"false",TIME:',
        'FORMAT:"image/png",TRANSPARENT:"true",BGCOLOR:"0x07111f",TIME:',
        'transparent GIBS no-data',
    ),
    (
        '''    function satelliteProbeLooksValid(img){
      if(!satPixelProbeSupported)return true;
      try{
        const width=96,height=Math.max(54,Math.round(width*(img.naturalHeight/img.naturalWidth)));
        const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;
        const ctx=canvas.getContext("2d",{willReadFrequently:true});
        if(!ctx)return true;
        ctx.drawImage(img,0,0,width,height);
        const data=ctx.getImageData(0,0,width,height).data;
        let count=0,nonBlack=0,minLum=255,maxLum=0,sumLum=0;
        for(let i=0;i<data.length;i+=4){
          if(data[i+3]<16)continue;
          const lum=(data[i]+data[i+1]+data[i+2])/3;
          count++;sumLum+=lum;if(lum>3)nonBlack++;if(lum<minLum)minLum=lum;if(lum>maxLum)maxLum=lum;
        }
        if(!count)return false;
        const average=sumLum/count;
        return nonBlack/count>.01&&(maxLum-minLum>6||average>8);
      }catch(error){
        satPixelProbeSupported=false;
        console.warn("Satellite pixel validation unavailable; using exact GIBS cadence.",error);
        return true;
      }
    }
''',
        '''    function satelliteProbeLooksValid(img){
      if(!satPixelProbeSupported)return null;
      try{
        const width=128,height=Math.max(72,Math.round(width*(img.naturalHeight/img.naturalWidth)));
        const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;
        const ctx=canvas.getContext("2d",{willReadFrequently:true});
        if(!ctx)return null;
        ctx.drawImage(img,0,0,width,height);
        const data=ctx.getImageData(0,0,width,height).data;
        const totalPixels=data.length/4;
        let count=0,nonBlack=0,minLum=255,maxLum=0,sumLum=0;
        for(let i=0;i<data.length;i+=4){
          if(data[i+3]<16)continue;
          const lum=(data[i]+data[i+1]+data[i+2])/3;
          count++;
          sumLum+=lum;
          if(lum>5)nonBlack++;
          if(lum<minLum)minLum=lum;
          if(lum>maxLum)maxLum=lum;
        }
        if(!count)return false;
        const average=sumLum/count;
        const opaqueCoverage=count/totalPixels;
        const nonBlackFraction=nonBlack/count;
        const contrast=maxLum-minLum;
        return (
          opaqueCoverage>.08&&
          nonBlackFraction>.08&&
          (contrast>8||average>12)
        );
      }catch(error){
        satPixelProbeSupported=false;
        console.warn("Satellite pixel validation unavailable; applying conservative GIBS age gate.",error);
        return null;
      }
    }
''',
        'stricter GIBS pixel validation',
    ),
    (
        '''        const img=new Image();img.decoding="async";img.crossOrigin="anonymous";
        img.onload=()=>finish(satelliteProbeLooksValid(img));
        img.onerror=()=>{
          const fallback=new Image();fallback.decoding="async";
          fallback.onload=()=>{satPixelProbeSupported=false;finish(true);};
          fallback.onerror=()=>finish(false);
          fallback.src=url;
        };
''',
        '''        const ageGateValid=()=>
          (Date.now()-frameTime.getTime())/60000>=45;
        const img=new Image();img.decoding="async";img.crossOrigin="anonymous";
        img.onload=()=>{
          const pixelValidity=satelliteProbeLooksValid(img);
          finish(pixelValidity===null?ageGateValid():pixelValidity);
        };
        img.onerror=()=>{
          const fallback=new Image();fallback.decoding="async";
          fallback.onload=()=>{
            satPixelProbeSupported=false;
            finish(ageGateValid());
          };
          fallback.onerror=()=>finish(false);
          fallback.src=url;
        };
''',
        'conservative unknown-frame age gate',
    ),
]

for old, new, label in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one {label} target, found {count}")
    text = text.replace(old, new, 1)

path.write_text(text, encoding="utf-8")
print("Applied GIBS Clean IR/Air Mass validity and no-data fixes.")
