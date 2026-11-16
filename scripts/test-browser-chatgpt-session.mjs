import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  runDirectory, findChrome, prepareFixture, reserveDebugPort, connectToChrome,
  createCDP, evaluator, waitFor, capture, stopChrome,
} from './test-browser-oauth.mjs';

const CHANNEL = 'tabflow-chatgpt-session-v1';
const EMAIL = 'session-test@example.invalid';
const MODEL = 'session-fixture-model';
const AUTH_RULE = 987654322;
let probeServer;
let probeRequests = 0;
const probeCounts = new Map();

async function prepareSessionFixture() {
  // No CORS response headers: this checks real worker host permissions, using
  // only a server owned by this test and never a user's loopback listener.
  probeServer = createServer((request, response) => {
    probeRequests++;
    const operation = new URL(request.url, 'http://127.0.0.1').searchParams.get('operation');
    if (operation) probeCounts.set(operation, (probeCounts.get(operation) ?? 0) + 1);
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('session-worker-probe');
  });
  await new Promise((resolve, reject) => { probeServer.once('error', reject); probeServer.listen(0, '127.0.0.1', resolve); });
  const probeURL = `http://127.0.0.1:${probeServer.address().port}/probe`;

  const directory = await prepareFixture();
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.web_accessible_resources.push({ resources: ['mock-authorization.html'], matches: ['https://auth.openai.com/*'] });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'session-fixture-key', alg: 'RS256', use: 'sig' };
  const assets = await readdir(path.join(directory, 'assets'));
  const workers = assets.filter(name => /^chatgpt-session\.worker-.*\.js$/.test(name));
  assert.equal(workers.length, 1, 'Expected one packaged session worker.');
  // Only the copied test fixture receives synthetic keys/network responses. The
  // production worker, real profiles and real OpenAI endpoints are untouched.
  const mockNetwork = `
const fixturePrivateKey = ${JSON.stringify(privateJwk)};
const fixturePublicKey = ${JSON.stringify(publicJwk)};
globalThis.__sessionFixture = { tokens: 0, models: 0, responses: 0, revoked: 0 };
const fixtureB64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\\+/g,'-').replace(/\\//g,'_');
const fixtureDecode = text => Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const fixtureJson = value => new Response(JSON.stringify(value),{headers:{'content-type':'application/json','x-request-id':'req_session_fixture'}});
const fixtureNativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init={}) => {
 const url = typeof input === 'string' ? input : input.url;
 const probeURL = new URL(${JSON.stringify(probeURL)});probeURL.searchParams.set('operation',new URL(url).pathname);
 const probe = await fixtureNativeFetch(probeURL,{credentials:'omit',redirect:'error'});
 if(await probe.text()!=='session-worker-probe')throw Error('Worker cross-origin permission probe failed');
 if(url === 'https://auth.openai.com/.well-known/openid-configuration') return fixtureJson({issuer:'https://auth.openai.com',jwks_uri:'https://auth.openai.com/.well-known/jwks.json',revocation_endpoint:'https://auth.openai.com/api/accounts/oauth/revoke'});
 if(url === 'https://auth.openai.com/.well-known/jwks.json') return fixtureJson({keys:[fixturePublicKey]});
 if(url === 'https://auth.openai.com/api/accounts/oauth/token') {
  __sessionFixture.tokens++;
  const form = new URLSearchParams(init.body);
  const code = JSON.parse(new TextDecoder().decode(fixtureDecode(form.get('code'))));
  const challenge=fixtureB64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(form.get('code_verifier')))));
  if(challenge!==code.challenge || form.get('client_id')!=='session-fixture-issued-client')throw Error('Fixture PKCE/client mismatch');
  const now=Math.floor(Date.now()/1000);
  const header=fixtureB64(new TextEncoder().encode(JSON.stringify({alg:'RS256',kid:'session-fixture-key'})));
  const payload=fixtureB64(new TextEncoder().encode(JSON.stringify({iss:'https://auth.openai.com',aud:'session-fixture-issued-client',sub:'session-fixture-subject',email:${JSON.stringify(EMAIL)},iat:now-1,exp:now+3600,nonce:code.nonce})));
  const key=await crypto.subtle.importKey('jwk',fixturePrivateKey,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const signature=fixtureB64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(header+'.'+payload))));
  return fixtureJson({access_token:'SESSION_FIXTURE_ACCESS_ONLY',refresh_token:'SESSION_FIXTURE_REFRESH_ONLY',id_token:header+'.'+payload+'.'+signature,token_type:'Bearer',expires_in:3600,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'});
 }
 if(url === 'https://auth.openai.com/api/accounts/oauth/revoke'){__sessionFixture.revoked++;return new Response('',{status:200});}
 const headers=new Headers(init.headers);
 if(headers.get('Authorization')!=='Bearer SESSION_FIXTURE_ACCESS_ONLY')throw Error('Fixture missing worker-owned bearer');
 if(url === 'https://api.openai.com/v1/models'){__sessionFixture.models++;return fixtureJson({models:[{slug:${JSON.stringify(MODEL)},display_name:'GPT-6.1-Sol',visibility:'list'}]});}
 if(url === 'https://api.openai.com/v1/responses'){
  __sessionFixture.responses++;
  const body=JSON.parse(init.body);
  if(body.store!==false || body.stream!==true)throw Error('Fixture request contract mismatch');
  const tabs=JSON.parse(body.input[0].content);
  return fixtureJson({object:'response',status:'completed',error:null,incomplete_details:null,output:[{type:'message',status:'completed',content:[{type:'output_text',text:JSON.stringify({groups:[{name:'测试资料',color:'blue',tabIds:tabs.map(tab=>tab.id)}]})}]}]});
 }
 throw Error('Unexpected fixture network request');
};
`;
  const workerPath = path.join(directory, 'assets', workers[0]);
  await writeFile(workerPath, mockNetwork + '\n' + await readFile(workerPath, 'utf8'));
  await writeFile(path.join(directory, 'mock-authorization.html'), '<!doctype html><html><body>Fixture authorization<script type="module" src="mock-authorization.js"></script></body></html>');
  await writeFile(path.join(directory, 'mock-authorization.js'), `
const query=new URLSearchParams(location.search);
const tab=await chrome.tabs.getCurrent();
const rules=await chrome.declarativeNetRequest.getSessionRules();
if(!rules.some(rule=>rule.condition.tabIds?.includes(tab.id)&&rule.condition.regexFilter?.includes('1455/auth/callback')))throw Error('Production callback interception missing; never contact loopback');
const code=btoa(JSON.stringify({nonce:query.get('nonce'),challenge:query.get('code_challenge')})).replace(/=/g,'').replace(/\\+/g,'-').replace(/\\//g,'_');
const result=new URLSearchParams({code,state:query.get('state'),client_id:'session-fixture-issued-client'});
location.href='http://127.0.0.1:1455/auth/callback?'+result;
`);
  return directory;
}

async function openSettings(cdp, extensionId) {
  const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/options.html` });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1050, deviceScaleFactor: 2, mobile: false }, sessionId);
  const evaluate = evaluator(cdp, sessionId);
  await waitFor(() => evaluate('Boolean(document.querySelector("select"))'), 'settings render');
  await evaluate(`(() => {const select=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='chatgpt_plan'));select.value='chatgpt_plan';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  return { targetId, sessionId, evaluate };
}

async function callSession(evaluate, command, args = []) {
  const reply = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ channel: CHANNEL, target: 'background', command, args })})`);
  assert.equal(reply?.ok, true, JSON.stringify(reply));
  return reply.value;
}

async function testSession(cdp, extensionId) {
  let view = await openSettings(cdp, extensionId);
  await waitFor(() => view.evaluate('document.body.innerText.includes("Continue with ChatGPT")'), 'initial sign-in state');
  await view.evaluate(`chrome.declarativeNetRequest.updateSessionRules({addRules:[{id:${AUTH_RULE},priority:10,action:{type:'redirect',redirect:{regexSubstitution:chrome.runtime.getURL('mock-authorization.html')+'\\\\1'}},condition:{regexFilter:'^https://auth[.]openai[.]com/api/accounts/authorize([?].*)?$',resourceTypes:['main_frame']}}]})`);
  await view.evaluate(`([...document.querySelectorAll('button')].find(button=>button.textContent.includes('Continue with ChatGPT'))).click()`);
  await waitFor(() => view.evaluate(`document.body.innerText.includes(${JSON.stringify(EMAIL)}) && [...document.querySelectorAll('select option')].some(option=>option.value===${JSON.stringify(MODEL)})`), 'real core OAuth completion and model catalog', 25_000);
  let text = await view.evaluate('document.body.innerText');
  assert(!text.includes('注册 1') && !text.includes('当前账户：') && !text.includes('关闭后需重新登录'));
  assert(!text.includes('使用自己的 ChatGPT 订阅，无需安装本机组件。实验接入仍在验证。'));
  assert(!text.includes('Continue with ChatGPT'), 'Connected layout must hide the login CTA.');
  await view.evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='浅色')?.click()`);
  await capture(cdp, view.sessionId, 'connected-compact-ui.png');
  const initialStatus = await callSession(view.evaluate, 'initialize');
  assert.equal(initialStatus.loggedIn, true);
  const model = [{ id: 11, title: '资料 A', url: 'https://example.invalid/a', groupId: -1 }, { id: 22, title: '资料 B', url: 'https://example.invalid/b', groupId: -1 }];
  const expected = [{ name: '测试资料', color: 'blue', tabIds: [11, 22] }];
  assert.deepEqual(await callSession(view.evaluate, 'group', [model, MODEL]), expected);
  const contextsBefore = await view.evaluate('chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"]})');
  assert.equal(contextsBefore.length, 1, 'Expected one independent session host.');
  assert.equal(probeCounts.get('/api/accounts/oauth/token'), 1);
  // No debugger is attached to the offscreen document or credential worker.
  await cdp.send('Target.closeTarget', { targetId: view.targetId });
  // Stop only service workers in this test's isolated Chrome profile.
  const { targetId: controlId } = await cdp.send('Target.createTarget', { url: 'about:blank#session-lifecycle-control' });
  const { sessionId: controlSession } = await cdp.send('Target.attachToTarget', { targetId: controlId, flatten: true });
  await cdp.send('ServiceWorker.enable', {}, controlSession);
  await cdp.send('ServiceWorker.stopAllWorkers', {}, controlSession);
  await waitFor(async () => !(await cdp.send('Target.getTargets')).targetInfos.some(target => target.type === 'service_worker' && target.url === `chrome-extension://${extensionId}/background.js`), 'extension service worker stopped');
  view = await openSettings(cdp, extensionId);
  await waitFor(() => view.evaluate(`document.body.innerText.includes(${JSON.stringify(EMAIL)}) && [...document.querySelectorAll('select option')].some(option=>option.value===${JSON.stringify(MODEL)})`), 'account restored after UI close and service worker restart', 25_000);
  const restored = await callSession(view.evaluate, 'initialize');
  assert.equal(restored.account.id, initialStatus.account.id);
  assert.equal(restored.loggedIn, true);
  assert.deepEqual(await callSession(view.evaluate, 'group', [model, MODEL]), expected);
  const contextsAfter = await view.evaluate('chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"]})');
  assert.equal(contextsAfter[0].documentId, contextsBefore[0].documentId, 'UI/SW restart must reuse the same session host.');
  assert.equal(probeCounts.get('/api/accounts/oauth/token'), 1, 'Reopening UI must not run OAuth again.');
  assert.equal(probeCounts.get('/v1/responses'), 2, 'Both model calls must complete using the retained session.');
  const storage = await view.evaluate('(async()=>({local:await chrome.storage.local.get(null),sync:await chrome.storage.sync.get(null),session:await chrome.storage.session.get(null)}))()');
  const encoded = JSON.stringify(storage);
  assert(!encoded.includes('SESSION_FIXTURE_ACCESS_ONLY') && !encoded.includes('SESSION_FIXTURE_REFRESH_ONLY') && !encoded.includes('id_token'), 'Credentials must never enter browser storage.');
  const targetsAfter = (await cdp.send('Target.getTargets')).targetInfos;
  assert(!targetsAfter.some(target => target.url.includes('/api/accounts/authorize')), 'No new authorization tab expected.');
  await capture(cdp, view.sessionId, 'restored-compact-ui.png');
  await callSession(view.evaluate, 'signOut');
  const loggedOut = await callSession(view.evaluate, 'initialize');
  assert.equal(loggedOut.loggedIn, false);
  assert.equal(probeCounts.get('/api/accounts/oauth/revoke'), 1);
  await view.evaluate(`chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[${AUTH_RULE}]})`);
  return { initialLogin: true, uiReopenRetainsSession: true, serviceWorkerRestartRetainsSession: true, inferenceBeforeAndAfter: true, browserStorageContainsCredentials: false, remoteRevocation: true, workerRequests: Object.fromEntries(probeCounts) };
}

let chrome, cdp, exited;
let evidence = { realAuthorization: false, usesExistingProfile: false };
try {
  const extensionDirectory = await prepareSessionFixture();
  const port = await reserveDebugPort();
  const executable = await findChrome();
  chrome = spawn(executable, ['--headless=new','--no-first-run','--no-default-browser-check','--disable-gpu','--disable-sync','--disable-background-networking','--enable-unsafe-extension-debugging',`--remote-debugging-port=${port}`,`--user-data-dir=${path.join(runDirectory,'profile')}`,'about:blank'], { stdio: 'ignore' });
  let launchError;
  chrome.once('error', error => { launchError = error; });
  exited = new Promise(resolve => { chrome.once('exit', resolve); chrome.once('error', resolve); });
  const connection = await connectToChrome(port, () => launchError);
  cdp = createCDP(connection.socket);
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: extensionDirectory });
  const result = await testSession(cdp, loaded.id);
  cdp.checkEvents();
  assert(probeRequests > 0, 'Worker must exercise real cross-origin network permissions.');
  evidence = { ...evidence, passed: true, browser: connection.version.Browser, extensionId: loaded.id, ...result, workerCrossOriginProbeRequests: probeRequests };
  console.log('Verified: compact connected UI, real core RSA OAuth, model requests before/after UI close and SW restart, memory-only credentials and sign-out.');
} catch (error) {
  evidence = { ...evidence, passed: false, error: error.message };
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
} finally {
  if (chrome) await stopChrome(cdp, chrome, exited);
  if (probeServer) {
    probeServer.closeAllConnections();
    await new Promise(resolve => probeServer.close(resolve));
  }
  await writeFile(path.join(runDirectory,'session-result.json'),JSON.stringify(evidence,null,2));
  console.log(`Evidence: ${runDirectory}`);
}
