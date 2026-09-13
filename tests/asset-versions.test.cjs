const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {versionAssets}=require('../scripts/version-assets.cjs');
test('local assets use content versions so cached JavaScript cannot mismatch the page',()=>{
 const html=fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8');
 assert.equal(html===versionAssets(html),true,'Run npm run version:assets after changing a local script or stylesheet.');
 assert.match(html,/<script src="app\.js\?v=[a-f0-9]{12}"><\/script>/);
});
