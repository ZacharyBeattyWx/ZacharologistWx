from pathlib import Path

path = Path("weather-viewer.html")
text = path.read_text(encoding="utf-8")
nl = "\r\n" if "\r\n" in text else "\n"


def replace_range(start_marker, end_marker, replacement, name):
    global text
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f"Could not find start of {name}")
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit(f"Could not find end of {name}")
    end += len(end_marker)
    text = text[:start] + replacement + text[end:]


mercator_marker = "    function mercator(lon,lat){"
mercator_start = text.find(mercator_marker)
if mercator_start < 0:
    raise SystemExit("Could not find mercator helper")
mercator_end = text.find(nl, mercator_start)
if mercator_end < 0:
    raise SystemExit("Could not find end of mercator helper")

helper_lines = [
    '    function fitSatelliteBboxToStage(projectedBbox,sector){',
    '      if(',
    '        sector?.id==="global"||',
    '        !window.matchMedia("(min-width: 881px)").matches',
    '      ){',
    '        return projectedBbox.slice();',
    '      }',
    '',
    '      let [minX,minY,maxX,maxY]=',
    '        projectedBbox.map(Number);',
    '',
    '      const spanX=maxX-minX;',
    '      const spanY=maxY-minY;',
    '',
    '      if(!(spanX>0&&spanY>0)){',
    '        return projectedBbox.slice();',
    '      }',
    '',
    '      const stageWidth=Math.max(',
    '        1,',
    '        (satelliteStage.clientWidth||1400)-8',
    '      );',
    '      const stageHeight=Math.max(',
    '        1,',
    '        (satelliteStage.clientHeight||820)-8',
    '      );',
    '      const targetRatio=stageWidth/stageHeight;',
    '      const centerX=(minX+maxX)/2;',
    '      const centerY=(minY+maxY)/2;',
    '      const currentRatio=spanX/spanY;',
    '',
    '      if(currentRatio<targetRatio){',
    '        const halfWidth=',
    '          (spanY*targetRatio)/2;',
    '        minX=centerX-halfWidth;',
    '        maxX=centerX+halfWidth;',
    '      }else if(currentRatio>targetRatio){',
    '        const halfHeight=',
    '          (spanX/targetRatio)/2;',
    '        minY=centerY-halfHeight;',
    '        maxY=centerY+halfHeight;',
    '      }',
    '',
    '      const worldLimit=20037508.342789244;',
    '',
    '      if(minX<-worldLimit){',
    '        maxX+=(-worldLimit-minX);',
    '        minX=-worldLimit;',
    '      }',
    '      if(maxX>worldLimit){',
    '        minX-=(maxX-worldLimit);',
    '        maxX=worldLimit;',
    '      }',
    '      if(minY<-worldLimit){',
    '        maxY+=(-worldLimit-minY);',
    '        minY=-worldLimit;',
    '      }',
    '      if(maxY>worldLimit){',
    '        minY-=(maxY-worldLimit);',
    '        maxY=worldLimit;',
    '      }',
    '',
    '      return [minX,minY,maxX,maxY];',
    '    }',
]
helper = nl.join(helper_lines) + nl
text = text[:mercator_end + len(nl)] + helper + text[mercator_end + len(nl):]

context_start = '      const product=satProductSpec(),sector=currentSectorSpec(),[west,south,east,north]=sector.bbox;'
context_end = '      const ratio=Math.max(.45,Math.min(3.2,(maxX-minX)/(maxY-minY)));'
new_context = nl.join([
    '      const product=satProductSpec(),sector=currentSectorSpec(),[west,south,east,north]=sector.bbox;',
    '      const [rawMinX,rawMinY]=mercator(west,south),[rawMaxX,rawMaxY]=mercator(east,north);',
    '      const [minX,minY,maxX,maxY]=fitSatelliteBboxToStage(',
    '        [rawMinX,rawMinY,rawMaxX,rawMaxY],',
    '        sector',
    '      );',
    '      const ratio=Math.max(.45,Math.min(3.2,(maxX-minX)/(maxY-minY)));',
])
replace_range(context_start, context_end, new_context, "satellite context geometry")

draw_start = '    function drawPreparedSatellite(img,context){'
draw_end = '      if(!(spanX>0&&spanY>0))return false;'
new_draw = nl.join([
    '    function drawPreparedSatellite(img,context){',
    '      const source=context.sourceBbox;',
    '      const target=context.bbox;',
    '',
    '      if(!source||!target)return false;',
    '',
    '      const [sw,ss,se,sn]=source;',
    '      const [sourceMinX,sourceMinY]=mercator(sw,ss);',
    '      const [sourceMaxX,sourceMaxY]=mercator(se,sn);',
    '',
    '      let [',
    '        targetMinX,',
    '        targetMinY,',
    '        targetMaxX,',
    '        targetMaxY',
    '      ]=target.map(Number);',
    '',
    '      const spanX=sourceMaxX-sourceMinX;',
    '      const spanY=sourceMaxY-sourceMinY;',
    '',
    '      if(!(spanX>0&&spanY>0))return false;',
    '',
    '      const desiredRatio=Math.max(',
    '        .45,',
    '        Math.min(',
    '          3.2,',
    '          Number(context.ratio)||',
    '          (',
    '            (targetMaxX-targetMinX)/',
    '            (targetMaxY-targetMinY)',
    '          )',
    '        )',
    '      );',
    '',
    '      let targetWidth=targetMaxX-targetMinX;',
    '      let targetHeight=targetMaxY-targetMinY;',
    '',
    '      if(!(targetWidth>0&&targetHeight>0))return false;',
    '',
    '      if(targetWidth>spanX){',
    '        targetMinX=sourceMinX;',
    '        targetMaxX=sourceMaxX;',
    '      }else{',
    '        if(targetMinX<sourceMinX){',
    '          const shift=sourceMinX-targetMinX;',
    '          targetMinX+=shift;',
    '          targetMaxX+=shift;',
    '        }',
    '        if(targetMaxX>sourceMaxX){',
    '          const shift=targetMaxX-sourceMaxX;',
    '          targetMinX-=shift;',
    '          targetMaxX-=shift;',
    '        }',
    '      }',
    '',
    '      if(targetHeight>spanY){',
    '        targetMinY=sourceMinY;',
    '        targetMaxY=sourceMaxY;',
    '      }else{',
    '        if(targetMinY<sourceMinY){',
    '          const shift=sourceMinY-targetMinY;',
    '          targetMinY+=shift;',
    '          targetMaxY+=shift;',
    '        }',
    '        if(targetMaxY>sourceMaxY){',
    '          const shift=targetMaxY-sourceMaxY;',
    '          targetMinY-=shift;',
    '          targetMaxY-=shift;',
    '        }',
    '      }',
    '',
    '      targetWidth=targetMaxX-targetMinX;',
    '      targetHeight=targetMaxY-targetMinY;',
    '',
    '      const constrainedRatio=',
    '        targetWidth/targetHeight;',
    '',
    '      if(constrainedRatio<desiredRatio){',
    '        const newHeight=',
    '          targetWidth/desiredRatio;',
    '        const centerY=',
    '          (targetMinY+targetMaxY)/2;',
    '        targetMinY=centerY-newHeight/2;',
    '        targetMaxY=centerY+newHeight/2;',
    '',
    '        if(targetMinY<sourceMinY){',
    '          const shift=sourceMinY-targetMinY;',
    '          targetMinY+=shift;',
    '          targetMaxY+=shift;',
    '        }',
    '        if(targetMaxY>sourceMaxY){',
    '          const shift=targetMaxY-sourceMaxY;',
    '          targetMinY-=shift;',
    '          targetMaxY-=shift;',
    '        }',
    '      }else if(constrainedRatio>desiredRatio){',
    '        const newWidth=',
    '          targetHeight*desiredRatio;',
    '        const centerX=',
    '          (targetMinX+targetMaxX)/2;',
    '        targetMinX=centerX-newWidth/2;',
    '        targetMaxX=centerX+newWidth/2;',
    '',
    '        if(targetMinX<sourceMinX){',
    '          const shift=sourceMinX-targetMinX;',
    '          targetMinX+=shift;',
    '          targetMaxX+=shift;',
    '        }',
    '        if(targetMaxX>sourceMaxX){',
    '          const shift=targetMaxX-sourceMaxX;',
    '          targetMinX-=shift;',
    '          targetMaxX-=shift;',
    '        }',
    '      }',
])
replace_range(draw_start, draw_end, new_draw, "prepared satellite crop")

path.write_text(text, encoding="utf-8")
print("Applied regional desktop stage-fit geometry.")
