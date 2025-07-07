import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  cleanAnsiCodes,
  createFriendlyName
} from './cloudformation_format.js';

void describe('createFriendlyName function', () => {
  void it('handles empty string by returning the original ID', () => {
    const emptyId = '';
    assert.strictEqual(createFriendlyName(emptyId), emptyId);
  });

  void it('uses CDK metadata construct path when available', () => {
    const logicalId = 'amplifyFunction123ABC45';
    const metadata = { constructPath: 'MyStack/MyFunction/Resource' };
    assert.strictEqual(
      createFriendlyName(logicalId, metadata),
      'MyStack/MyFunction/Resource',
    );
  });

  void it('removes amplify prefix and formats camel case', () => {
    const logicalId = 'amplifyDataTable123ABC45';
    assert.strictEqual(createFriendlyName(logicalId), 'Data Table A B C45');
  });

  void it('removes Amplify prefix (capitalized) and formats camel case', () => {
    const logicalId = 'AmplifyDataTable123ABC45';
    assert.strictEqual(createFriendlyName(logicalId), 'Data Table A B C45');
  });

  void it('handles IDs with only numeric characters', () => {
    const numericId = '12345';
    assert.strictEqual(createFriendlyName(numericId), numericId);
  });

  void it('normalizes CDK construct paths', () => {
    const logicalId = 'amplifyFunction';
    const metadata = {
      constructPath: 'MyStack/auth.NestedStack/auth.NestedStackResource',
    };
    assert.strictEqual(createFriendlyName(logicalId, metadata), 'MyStack/auth');
  });

  void it('removes amplify prefixes from CDK construct paths', () => {
    const logicalId = 'amplifyFunction';
    const metadata = { constructPath: 'MyStack/amplifyAuth/MyFunction' };
    assert.strictEqual(
      createFriendlyName(logicalId, metadata),
      'MyStack/MyFunction',
    );
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

  void it('handles specific ANSI code formats', () => {
    const text = 'Text with [2mDim[22m and [1mBold[22m formatting';
    assert.strictEqual(
      cleanAnsiCodes(text),
      'Text with Dim and Bold formatting',
    );
  });
});
