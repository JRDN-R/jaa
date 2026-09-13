const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..');
// A changed file gets a new URL, so a cached script cannot run against new HTML.
const localAsset=/(<(?:script|link)\b[^>]*\b(?:src|href)=")([^"?#:]+\.(?:js|css))(?:\?[^"#]*)?("[^>]*>)/g;
function versionAssets(html){
 return html.replace(localAsset,(_,before,file,after)=>{
  const hash=createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex').slice(0,12);
  return before+file+'?v='+hash+after;
 });
}
if(require.main===module){
 const filename=path.join(root,'index.html'),html=fs.readFileSync(filename,'utf8');
 fs.writeFileSync(filename,versionAssets(html));
 console.log('Updated local script and stylesheet versions.');
}
module.exports={versionAssets};
