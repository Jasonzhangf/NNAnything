import http from 'node:http';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {profiles,scenarios} from './cases.mjs';
import {renderPage} from './page.mjs';
import {renderFamilyBPage} from './family-b/page.mjs';
import {familyBSearch} from './family-b/data.mjs';

const familyBClient=readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),'family-b/client.js'),'utf8');

export function createFixtureServer() {
  return http.createServer((request,response)=>{
    const url=new URL(request.url,'http://127.0.0.1');
    if(url.pathname==='/favicon.ico'){response.writeHead(204);response.end();return;}
    if(url.pathname==='/family-b/'||url.pathname==='/family-b'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});response.end(renderFamilyBPage());return;}
    if(url.pathname==='/family-b/client.js'){response.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'});response.end(familyBClient);return;}
    if(url.pathname==='/family-b/api/search'){
      const query=url.searchParams.get('q')??'';const requestRef=url.searchParams.get('request')??'';const scenario=url.searchParams.get('scenario')??'normal';
      if(!query||!requestRef||!scenarios.includes(scenario)){response.writeHead(400);response.end('Invalid family B search request');return;}
      const delay=query.includes('slow')?600:scenario==='same-word-stalled'?30000:scenario==='same-word'?60:30;
      setTimeout(()=>{response.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
        response.end(JSON.stringify(familyBSearch({query,requestRef,scenario})));},delay);
      return;
    }
    if(url.pathname!=='/'){response.writeHead(404);response.end('Not found');return;}
    const profile=profiles.find(item=>item.id===(url.searchParams.get('profile')??profiles[0].id));
    const scenario=url.searchParams.get('scenario')??'normal';
    const query=url.searchParams.get('q')??'';
    if(!profile||!scenarios.includes(scenario)){response.writeHead(400);response.end('Unknown fixture configuration');return;}
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    response.end(renderPage(profile,scenario,profiles,{query,scenarios}));
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const index=process.argv.indexOf('--port');
  const port=index<0?4173:Number(process.argv[index+1]);
  if(!Number.isInteger(port)||port<0||port>65535)throw new TypeError('Invalid --port');
  const server=createFixtureServer();
  server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,url:`http://127.0.0.1:${server.address().port}`})));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
