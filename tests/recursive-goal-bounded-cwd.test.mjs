import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runBoundedCwdScenarios} from '../playground/recursive-goal/bounded-cwd.mjs';

test('bounded planning uses one live cwd session and preserves real rejection and postcommit effects',async()=>{
  assert.equal(typeof process.env.NN_CLI_COMMAND_PROFILE,'string','an explicit saved command profile is required');
  const result=await runBoundedCwdScenarios({profilePath:process.env.NN_CLI_COMMAND_PROFILE});
  assert.equal(result.status,'PASS',JSON.stringify(result,null,2));
  for(const scenario of result.scenarios) {
    assert.equal(scenario.status,'PASS');
    assert.ok(scenario.predictionCalls>0);
    for(const response of scenario.responses) {
      assert.equal(response.kind,'run_result');
      assert.ok(response.report.atomicResults.length<=2,'never replay an atomic command');
      if(response.report.continuation) assert.equal(response.report.continuation.schema,'nnanything.recursive-goal.continuation.v2');
    }
    assert.equal(scenario.fixture.cleaned,true);
    assert.equal(scenario.fixture.foreignSessionUnchanged,true);
    assert.equal(scenario.fixture.agentCwdUnchanged,true);
    assert.equal(scenario.fixture.rootAbsent,true);
    if(scenario.name==='different') {
      assert.equal(scenario.finalSession.cwd,scenario.request.targetPhysical);
      assert.equal(scenario.finalSession.revision,scenario.initialSession.revision+1);
    }
  }
});
