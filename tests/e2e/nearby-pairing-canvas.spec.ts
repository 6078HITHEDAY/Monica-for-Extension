import {test,expect} from '@playwright/test';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {launchEdgeContext} from './fixtures/edge';
test('local pairing Canvas uses QR and links without manual addresses',async({},info)=>{
  const run=info.outputPath('isolated');await mkdir(run,{recursive:true});
  const context=await launchEdgeContext(path.join(run,'profile'),{viewport:{width:1400,height:1100}});
  try{const page=await context.newPage();await page.goto('http://127.0.0.1:5186/?project=monica-extension-wifi-pairing-320#doc='+encodeURIComponent(await readFile('docs/design/nearby-pairing-320.m3e.json','utf8')));
    await expect(page.getByText('配置本机通信组件',{exact:true}).first()).toBeVisible();
    await expect(page.getByText('改为输入配对链接',{exact:true}).first()).toBeVisible();
    await page.screenshot({path:path.join(run,'canvas.png'),fullPage:true});
  }finally{await context.close();}
});
