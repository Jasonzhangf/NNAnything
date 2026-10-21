import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {profiles,scenarios} from './cases.mjs';
import {renderPage} from './page.mjs';

export function createFixtureServer() {
  return http.createServer((request,response)=>{
    const url=new URL(request.url,'http://127.0.0.1');
    if(url.pathname==='/favicon.ico'){response.writeHead(204);response.end();return;}
    if(url.pathname!=='/'){response.writeHead(404);response.end('Not found');return;}
    const profile=profiles.find(item=>item.id===(url.searchParams.get('profile')??profiles[0].id));
    const scenario=url.searchParams.get('scenario')??'normal';
    if(!profile||!scenarios.includes(scenario)){response.writeHead(400);response.end('Unknown fixture configuration');return;}
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    response.end(renderPage(profile,scenario,profiles));
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
