import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { getLogGroupName } from './logging_utils.js';
import { LogLevel, printer } from '@aws-amplify/cli-core';

void describe('getLogGroupName function', () => {
  void it('returns correct log group name for Lambda functions', () => {
    const resourceType = 'AWS::Lambda::Function';
    const resourceId = 'my-lambda-function';
    assert.strictEqual(getLogGroupName(resourceType, resourceId), '/aws/lambda/my-lambda-function');
  });

  void it('returns correct log group name for API Gateway', () => {
    const resourceType = 'AWS::ApiGateway::RestApi';
    const resourceId = 'abc123def';
    assert.strictEqual(getLogGroupName(resourceType, resourceId), 'API-Gateway-Execution-Logs_abc123def');
  });

  void it('returns correct log group name for AppSync APIs', () => {
    const resourceType = 'AWS::AppSync::GraphQLApi';
    const resourceId = 'xyz789';
    assert.strictEqual(getLogGroupName(resourceType, resourceId), '/aws/appsync/apis/xyz789');
  });

  void it('returns null for unsupported resource types', () => {
    const resourceType = 'AWS::S3::Bucket';
    const resourceId = 'my-bucket';
    
    // Mock printer.log to verify warning is logged
    const printerLogMock = mock.method(printer, 'log');
    
    const result = getLogGroupName(resourceType, resourceId);
    
    assert.strictEqual(result, null);
    
    // Verify warning was logged
    let warningLogged = false;
    for (const call of printerLogMock.mock.calls) {
      if (call.arguments[0].includes('Unsupported resource type for logs') && 
          call.arguments[1] === LogLevel.WARN) {
        warningLogged = true;
        break;
      }
    }
    assert.ok(warningLogged, 'Warning should be logged for unsupported resource type');
  });
  
  void it('handles resource IDs with special characters', () => {
    const resourceType = 'AWS::Lambda::Function';
    const resourceId = 'my-function-with-special/chars';
    assert.strictEqual(getLogGroupName(resourceType, resourceId), '/aws/lambda/my-function-with-special/chars');
  });
  
  void it('handles resource IDs with ARN format', () => {
    const resourceType = 'AWS::Lambda::Function';
    const resourceId = 'arn:aws:lambda:us-west-2:123456789012:function:my-function';
    assert.strictEqual(getLogGroupName(resourceType, resourceId), '/aws/lambda/arn:aws:lambda:us-west-2:123456789012:function:my-function');
  });
});