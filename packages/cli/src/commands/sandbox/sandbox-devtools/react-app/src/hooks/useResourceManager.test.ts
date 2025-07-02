import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ResourceWithFriendlyName } from './useResourceManager.js';

void describe('useResourceManager', () => {
  void it('exports ResourceWithFriendlyName type', () => {
    const mockResource: ResourceWithFriendlyName = {
      logicalResourceId: 'test-id',
      physicalResourceId: 'test-physical-id',
      resourceType: 'AWS::Lambda::Function',
      resourceStatus: 'DEPLOYED',
      friendlyName: 'Test Resource',
      consoleUrl: 'https://console.aws.amazon.com',
    };

    assert.strictEqual(mockResource.logicalResourceId, 'test-id');
    assert.strictEqual(mockResource.resourceType, 'AWS::Lambda::Function');
    assert.strictEqual(mockResource.resourceStatus, 'DEPLOYED');
  });

  void it('handles optional properties', () => {
    const minimalResource: ResourceWithFriendlyName = {
      logicalResourceId: 'test-id',
      physicalResourceId: 'test-physical-id',
      resourceType: 'AWS::Lambda::Function',
      resourceStatus: 'DEPLOYED',
    };

    assert.strictEqual(minimalResource.friendlyName, undefined);
    assert.strictEqual(minimalResource.consoleUrl, undefined);
  });
});