/* eslint-disable spellcheck/spell-checker */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { 
  createFriendlyName,
  cleanAnsiCodes,
  isDeploymentProgressMessage,
  extractCloudFormationEvents 
} from './utils/cloudformation_utils.js';
import { getLogGroupName } from './utils/logging_utils.js';

void describe('createFriendlyName function', () => {
  void it('handles empty string by returning the original ID', () => {
    const emptyId = '';
    assert.strictEqual(createFriendlyName(emptyId), emptyId);
  });

  void it('handles IDs with only numeric characters', () => {
    const numericId = '12345';
    assert.strictEqual(createFriendlyName(numericId), numericId);
  });
  
  void it('removes amplify prefix and adds spaces before capital letters', () => {
    const id = 'amplifyLambdaFunction';
    assert.strictEqual(createFriendlyName(id), 'Lambda Function');
  });
  
  void it('removes Amplify prefix (capitalized) and adds spaces', () => {
    const id = 'AmplifyDynamoDBTable';
    assert.strictEqual(createFriendlyName(id), 'Dynamo D B Table');
  });
  
  void it('removes trailing 8-character hex strings', () => {
    const id = 'amplifyLambdaFunction12AB34CD';
    assert.strictEqual(createFriendlyName(id), 'Lambda Function');
  });
  
  void it('uses CDK construct path when available', () => {
    const id = 'amplifyLambdaFunction';
    const metadata = { constructPath: 'MyStack/MyFunction' };
    assert.strictEqual(createFriendlyName(id, metadata), 'MyStack/MyFunction');
  });
  
  void it('extracts friendly name from nested stack logical ID', () => {
    const id = 'amplify-myapp-dev-sandbox-12345-auth-ABCDEF12';
    assert.strictEqual(createFriendlyName(id), 'auth stack');
  });
  
  void it('identifies root stack from logical ID', () => {
    const id = 'amplify-myapp-dev-sandbox-12345';
    assert.strictEqual(createFriendlyName(id), 'root stack');
  });
});


