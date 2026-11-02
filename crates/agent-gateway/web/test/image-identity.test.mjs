import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";
const {fetchSingleUserImageIdentity}=createWebModuleLoader().loadModule("src/lib/imageIdentity.ts");
test("single-user identity comes only from authenticated server response",async()=>{
 let calls=0;
 const fetcher=async(url,init)=>{calls++;assert.equal(url,"https://gateway.test/api/image/identity");assert.equal(init.headers.Authorization,"Bearer fixture-token");assert.equal(init.redirect,"error");return Response.json({ownerId:"local",backendId:"configured-backend",mode:"single_user"});};
 assert.deepEqual(await fetchSingleUserImageIdentity("https://gateway.test","fixture-token",undefined,fetcher),{ownerId:"local",backendId:"configured-backend",gatewayOrigin:"https://gateway.test",accessToken:"fixture-token"});assert.equal(calls,1);
 await assert.rejects(()=>fetchSingleUserImageIdentity("https://gateway.test","",undefined,fetcher));assert.equal(calls,1);
 for(const body of [{ownerId:"forged",backendId:"id",mode:"single_user"},{ownerId:"local",backendId:"id",mode:"multi_user"},{ownerId:"local",backendId:"",mode:"single_user"}]){await assert.rejects(()=>fetchSingleUserImageIdentity("https://gateway.test","fixture-token",undefined,async()=>Response.json(body)));}
 await assert.rejects(()=>fetchSingleUserImageIdentity("https://gateway.test","fixture-token",undefined,async()=>new Response("",{status:503})),e=>e.code==="IMAGE_IDENTITY_UNAVAILABLE");
});
