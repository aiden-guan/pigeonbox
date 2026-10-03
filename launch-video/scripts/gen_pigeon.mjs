// Film derivatives use the shipped mascot, never a separately drawn body.
import {createRequire} from 'node:module';
import {copyFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const app=resolve(root,'..');
const sharp=createRequire(resolve(app,'package.json'))('sharp');
await copyFile(resolve(app,'apps/extension/public/brand/pigeon-sprites.png'),resolve(root,'public/brand/pigeon-sprites.png'));
await sharp(resolve(root,'public/brand/pigeon-sprites.png')).resize(200,200,{kernel:'nearest'}).png().toFile(resolve(root,'public/art/pigeon-sheet-1x.png'));
const cells=[];
for(const [i,frame] of [3,4,5,6,8].entries())cells.push({input:await sharp(resolve(root,'public/brand/pidgy-flight.webp')).extract({left:frame*112,top:0,width:112,height:112}).resize(50,50,{kernel:'nearest'}).png().toBuffer(),left:i*56+3,top:0});
await sharp({create:{width:280,height:50,channels:4,background:'#00000000'}}).composite(cells).png().toFile(resolve(root,'public/art/pigeon-fly-1x.png'));
console.log('Film sprites derived from approved production Pidgy art.');
