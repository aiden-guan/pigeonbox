import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sharp=createRequire(resolve(root,'../../package.json'))('sharp');
const source=resolve(root,'brand-src/pigeon-states.png');
const meta=await sharp(source).metadata();
if(meta.width!==384||meta.height!==480||!meta.hasAlpha)throw Error('Expected the approved 4x5 atlas of 96px cells.');
const cells=[];
for(let row=0;row<5;row++)for(let col=0;col<4;col++){
  const {data,info}=await sharp(source).extract({left:col*96,top:row*96,width:96,height:96}).raw().toBuffer({resolveWithObject:true});
  let left=96,top=96,right=0,bottom=0;
  for(let y=0;y<96;y++)for(let x=0;x<96;x++)if(data[(y*96+x)*4+3]>24){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);}
  const scale=200/56,width=Math.round((right-left)*scale),height=Math.round((bottom-top)*scale);
  if(width>312||height>248)throw Error(`Clipped frame ${row}/${col}`);
  const x=Math.max(4,Math.min(316-width,Math.round(160-(44-left)*scale)));
  cells.push({input:await sharp(data,{raw:info}).extract({left,top,width:right-left,height:bottom-top}).resize(width,height,{kernel:'nearest'}).png().toBuffer(),left:col*320+x,top:row*256+252-height});
}
const atlas=await sharp({create:{width:1280,height:1280,channels:4,background:'#00000000'}}).composite(cells).png().toBuffer();
await sharp(atlas).toFile(resolve(root,'public/brand/pigeon-sprites.png'));
await sharp(atlas).webp({lossless:true}).toFile(resolve(root,'public/brand/pigeon-sprites.webp'));
console.log('Packed 20 approved Pidgy frames into the existing 320x256 cells.');
