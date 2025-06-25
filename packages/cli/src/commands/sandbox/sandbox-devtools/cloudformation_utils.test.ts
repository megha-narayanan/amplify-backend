import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createFriendlyName,
  cleanAnsiCodes,
  isDeploymentProgressMessage,
  extractCloudFormationEvents
} from './utils/cloudformation_utils.js';

void describe('createFriendlyName function', () => {
  void it('handles empty string by returning the original ID', () => {
    const emptyId = '';
    assert.strictEqual(createFriendlyName(emptyId), emptyId);
  });

  void it('uses CDK metadata construct path when available', () => {
    const logicalId = 'amplifyFunction123ABC45';
    const metadata = { constructPath: 'MyStack/MyFunction/Resource' };
    assert.strictEqual(createFriendlyName(logicalId, metadata), 'MyStack/MyFunction/Resource');
  });

  void it('removes amplify prefix and breaks up', () => {
    const logicalId = 'amplifyDataTable123ABC45';
    assert.strictEqual(createFriendlyName(logicalId), 'Data Table A B C45');
  });
});

void describe('cleanAnsiCodes function', () => {
  void it('removes ANSI color codes from text', () => {
    const coloredText = '\u001b[32mSuccess\u001b[0m';
    assert.strictEqual(cleanAnsiCodes(coloredText), 'Success');
  });

  void it('handles text with multiple ANSI codes', () => {
    const coloredText = '\u001b[1m\u001b[36mBold Cyan\u001b[39m\u001b[22m';
    assert.strictEqual(cleanAnsiCodes(coloredText), 'Bold Cyan');
  });

  void it('returns original text when no ANSI codes are present', () => {
    const plainText = 'Plain text';
    assert.strictEqual(cleanAnsiCodes(plainText), plainText);
  });
});

void describe('isDeploymentProgressMessage function', () => {
  void it('identifies CloudFormation status messages', () => {
    assert.strictEqual(isDeploymentProgressMessage('CREATE_IN_PROGRESS'), true);
    assert.strictEqual(isDeploymentProgressMessage('UPDATE_COMPLETE'), true);
    assert.strictEqual(isDeploymentProgressMessage('DELETE_FAILED'), true);
  });

  void it('identifies deployment progress messages', () => {
    assert.strictEqual(isDeploymentProgressMessage('Deployment in progress'), true);
  });

  void it('identifies CloudFormation event log format', () => {
    const cfnEvent = '10:15:30 AM | CREATE_IN_PROGRESS | AWS::Lambda::Function | MyFunction';
    assert.strictEqual(isDeploymentProgressMessage(cfnEvent), true);
  });

  void it('returns false for non-deployment messages', () => {
    assert.strictEqual(isDeploymentProgressMessage('Regular log message'), false);
    assert.strictEqual(isDeploymentProgressMessage('Error: something went wrong'), false);
  });
});

void describe('extractCloudFormationEvents function', () => {
  void it('extracts CloudFormation events from log messages', () => {
    const logMessage = 'Some log message\n10:15:30 AM | CREATE_IN_PROGRESS | AWS::Lambda::Function | MyFunction\nAnother log message';
    const events = extractCloudFormationEvents(logMessage);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0], '10:15:30 AM | CREATE_IN_PROGRESS | AWS::Lambda::Function | MyFunction');
  });

  void it('extracts multiple CloudFormation events', () => {
    const logMessage = '10:15:30 AM | CREATE_IN_PROGRESS | AWS::Lambda::Function | MyFunction\n10:16:00 AM | CREATE_COMPLETE | AWS::Lambda::Function | MyFunction';
    const events = extractCloudFormationEvents(logMessage);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0], '10:15:30 AM | CREATE_IN_PROGRESS | AWS::Lambda::Function | MyFunction');
    assert.strictEqual(events[1], '10:16:00 AM | CREATE_COMPLETE | AWS::Lambda::Function | MyFunction');
  });

  void it('returns empty array when no events are found', () => {
    const logMessage = 'Regular log message without CloudFormation events';
    const events = extractCloudFormationEvents(logMessage);
    assert.strictEqual(events.length, 0);
  });
});