import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import { LogStreamingService } from './log_streaming_service.js';

void describe('LogStreamingService', () => {
  let logStreamingService: LogStreamingService;
  
  beforeEach(() => {
    mock.reset();
    logStreamingService = new LogStreamingService();
  });
  
  void describe('getActiveSubscriptions', () => {
    void it('returns the active subscriptions', () => {
      const subscriptions = new Set(['sub1', 'sub2']);
      (logStreamingService as any).activeSubscriptions = subscriptions;
      
      const result = logStreamingService.getActiveSubscriptions();
      
      // Verify
      assert.strictEqual(result, subscriptions);
    });
  });
  
  void describe('getWebSocketPort', () => {
    void it('returns the WebSocket port', () => {
      // Setup
      (logStreamingService as any).wsPort = 3334;
      
      const result = logStreamingService.getWebSocketPort();
      
      assert.strictEqual(result, 3334);
    });
  });
  
  void describe('getWebSocketServer', () => {
    void it('returns the WebSocket server', () => {
      // Setup
      const mockServer = { test: 'server' };
      (logStreamingService as any).wsServer = mockServer;
      
      // Execute
      const result = logStreamingService.getWebSocketServer();
      
      // Verify
      assert.strictEqual(result, mockServer);
    });
  });
});
