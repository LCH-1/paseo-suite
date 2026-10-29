import test from "node:test";
import assert from "node:assert/strict";
import {profileDiscovery} from "./profile-discovery.ts";

test("구형 사용량 소스에서는 설정된 Claude 프로필만 조회하고 같은 계정 별칭은 중복 계산하지 않는다",async()=>{
  const seen:any[]=[];
  const discover=profileDiscovery(async scope=>{seen.push(scope);return [{key:scope.env.CLAUDE_CONFIG_DIR}];},async()=>[
    {id:"claude",env:{CLAUDE_CONFIG_DIR:"first"}},
    {id:"claude-second",env:{CLAUDE_CONFIG_DIR:"second"}},
    {id:"claude-alias",env:{CLAUDE_CONFIG_DIR:"second"}},
    {id:"mengsk-claude",env:{CLAUDE_CONFIG_DIR:"custom"}},
  ]);
  assert.deepEqual((await discover({kind:"global"})).map(a=>a.key),["first","second"]);
  assert.deepEqual(seen.map(scope=>scope.provider),["claude","claude-second","claude-alias"]);
  assert.ok(seen.every(scope=>scope.kind==="session"));
});

test("대화 범위는 자동 선택된 실행 환경을 그대로 사용한다",async()=>{
  const scope={kind:"session",provider:"claude",env:{CLAUDE_CONFIG_DIR:"selected"}};
  const discover=profileDiscovery(async value=>{assert.equal(value,scope);return [{key:"selected"}];},async()=>{throw Error("Global lookup must not run");});
  assert.deepEqual(await discover(scope),[{key:"selected"}]);
});

test("한 프로필의 인증 조회 오류가 다른 계정 사용량을 숨기지 않는다",async()=>{
  const discover=profileDiscovery(async scope=>{if(scope.provider==="claude")throw Error("synthetic corrupt credentials");return [{key:"healthy"}];},async()=>[{id:"claude",env:{}},{id:"claude-second",env:{}}]);
  assert.deepEqual(await discover({kind:"global"}),[{key:"healthy"}]);
});
