import { LogLevel, printer } from '@aws-amplify/cli-core';
import { WebSocketServer, WebSocket } from 'ws';
import { networkInterfaces } from 'os';
import { randomUUID } from 'crypto';
import { 
  CloudWatchLogsClient, 
  PutSubscriptionFilterCommand, 
  DeleteSubscriptionFilterCommand 
} from '@aws-sdk/client-cloudwatch-logs';
import { 
  LambdaClient, 
  CreateFunctionCommand, 
  AddPermissionCommand, 
  GetFunctionCommand 
} from '@aws-sdk/client-lambda';
import { 
  IAMClient, 
  CreateRoleCommand, 
  PutRolePolicyCommand, 
  GetRoleCommand 
} from '@aws-sdk/client-iam';

/**
 * Service for handling real-time log streaming via WebSocket and Lambda
 */
export class LogStreamingService {
  private wsServer: WebSocketServer | null = null;
  private wsPort: number = 3334;
  private logForwarderLambdaArn: string | null = null;
  private activeSubscriptions = new Set<string>();

  /**
   * Initializes the WebSocket server for log streaming
   */
  public initializeWebSocketServer(): WebSocketServer {
    // Create WebSocket server for real-time log streaming
    const wsServer = new WebSocketServer({ port: this.wsPort });
    this.wsServer = wsServer;
    
    printer.log(`WebSocket server for log streaming started on port ${this.wsPort}`, LogLevel.INFO);
    
    return wsServer;
  }

  /**
   * Gets the local IP address to use for the WebSocket endpoint
   * @returns The local IP address or null if no suitable address is found
   */
  public async getLocalIpAddress(): Promise<string | null> {
    const nets = networkInterfaces();
    
    // Find a non-internal IPv4 address
    for (const name of Object.keys(nets)) {
      if(nets[name]!=undefined){
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal && net.address) {
            return net.address;
          }
        }
      }
    }
    // Return null instead of falling back to localhost
    printer.log(
      'Could not find a suitable network interface for external connections. ' +
      'Real-time log streaming will not be available. ' +
      'Falling back to polling-based logs.',
      LogLevel.WARN
    );
    return null;
  }

  /**
   * Creates or gets the IAM role for the log forwarder Lambda
   */
  private async createLogForwarderRole(): Promise<string> {
    const iamClient = new IAMClient();
    const roleName = 'amplify-devtools-log-forwarder-role';
    
    try {
      // Check if role already exists
      const getResponse = await iamClient.send(
        new GetRoleCommand({ RoleName: roleName })
      );
      if (!getResponse.Role?.Arn) {
        throw new Error('Role exists but Arn is undefined');
      }
      return getResponse.Role.Arn;
    } catch (error) {
      // Role doesn't exist, create it
      const createResponse = await iamClient.send(
        new CreateRoleCommand({
          RoleName: roleName,
          AssumeRolePolicyDocument: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: {
                  Service: 'lambda.amazonaws.com'
                },
                Action: 'sts:AssumeRole'
              }
            ]
          })
        })
      );
      
      if (!createResponse.Role?.Arn) {
        throw new Error('Failed to create role: Arn is undefined');
      }
      
      // Add permissions policy
      await iamClient.send(
        new PutRolePolicyCommand({
          RoleName: roleName,
          PolicyName: 'amplify-devtools-log-forwarder-policy',
          PolicyDocument: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'logs:CreateLogGroup',
                  'logs:CreateLogStream',
                  'logs:PutLogEvents'
                ],
                Resource: 'arn:aws:logs:*:*:*'
              }
            ]
          })
        })
      );
      
      // Wait for role to propagate
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      return createResponse.Role.Arn;
    }
  }

  /**
   * Creates or gets the log forwarder Lambda function
   */
  public async createLogForwarderLambda(): Promise<string | null> {
    const lambdaClient = new LambdaClient();
    const logForwarderName = 'amplify-devtools-log-forwarder';
    const localIp = await this.getLocalIpAddress();
    
    // If we couldn't find a suitable IP address, we can't create the Lambda function
    if (localIp === null) {
      printer.log(
        'Cannot create log forwarder Lambda function without a valid IP address. ' +
        'Real-time log streaming will not be available.',
        LogLevel.WARN
      );
      return null;
    }
    
    try {
      // Check if Lambda already exists
      const getResponse = await lambdaClient.send(
        new GetFunctionCommand({ FunctionName: logForwarderName })
      );
      
      if (!getResponse.Configuration?.FunctionArn) {
        throw new Error('Lambda function exists but FunctionArn is undefined');
      }
      
      this.logForwarderLambdaArn = getResponse.Configuration.FunctionArn;
      return getResponse.Configuration.FunctionArn;
    } catch (error) {
      // Lambda doesn't exist, create it
      const roleArn = await this.createLogForwarderRole();
      
      const createResponse = await lambdaClient.send(
        new CreateFunctionCommand({
          FunctionName: logForwarderName,
          Runtime: 'nodejs18.x',
          Role: roleArn,
          Handler: 'index.handler',
          Code: {
            ZipFile: Buffer.from(`
              const https = require('https');
              const http = require('http');
              const WebSocket = require('ws');
              const zlib = require('zlib');
              
              // WebSocket endpoint for your DevTools
              const wsEndpoint = process.env.WEBSOCKET_ENDPOINT;
              
              exports.handler = async (event, context) => {
                // Decode and decompress the CloudWatch Logs data
                const payload = Buffer.from(event.awslogs.data, 'base64');
                const decompressed = zlib.gunzipSync(payload).toString('utf8');
                const logData = JSON.parse(decompressed);
                
                // Extract resource ID from log group name
                const logGroupParts = logData.logGroup.split('/');
                const resourceId = logGroupParts[logGroupParts.length - 1];
                
                // Format log entries
                const logs = logData.logEvents.map(event => ({
                  timestamp: new Date(event.timestamp).toISOString(),
                  message: event.message
                }));
                
                // Send logs to WebSocket if we have any
                if (logs.length > 0 && wsEndpoint) {
                  try {
                    // Use http or https based on the endpoint
                    const ws = new WebSocket(wsEndpoint, {
                      rejectUnauthorized: false // Allow self-signed certs for local dev
                    });
                    
                    await new Promise((resolve, reject) => {
                      ws.on('open', () => {
                        ws.send(JSON.stringify({
                          event: 'resourceLogs',
                          data: {
                            resourceId,
                            logs
                          }
                        }));
                        resolve();
                      });
                      
                      ws.on('error', (error) => {
                        console.error('WebSocket error:', error);
                        reject(error);
                      });
                      
                      // Set a timeout in case connection hangs
                      setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000);
                    });
                    
                    ws.close();
                    return { statusCode: 200, body: 'Logs sent successfully' };
                  } catch (error) {
                    console.error('Error sending logs to WebSocket:', error);
                    return { statusCode: 500, body: 'Error sending logs' };
                  }
                }
                
                return { statusCode: 200, body: 'No logs to process' };
              };
            `)
          },
          Environment: {
            Variables: {
              WEBSOCKET_ENDPOINT: `ws://${localIp}:${this.wsPort}`
            }
          },
          Timeout: 10 // 10 seconds
        })
      );
      
      // Add permission for CloudWatch Logs to invoke this Lambda
      await lambdaClient.send(
        new AddPermissionCommand({
          FunctionName: logForwarderName,
          StatementId: 'cloudwatch-logs-invoke',
          Action: 'lambda:InvokeFunction',
          Principal: 'logs.amazonaws.com'
        })
      );
      
      if (!createResponse.FunctionArn) {
        throw new Error('Failed to create Lambda function: FunctionArn is undefined');
      }
      
      this.logForwarderLambdaArn = createResponse.FunctionArn;
      return createResponse.FunctionArn;
    }
  }

  /**
   * Sets up a subscription filter for a log group
   */
  public async setupLogSubscription(logGroupName: string, resourceId: string): Promise<boolean> {
    try {
      // Create or get the Lambda function
      const logForwarderArn = await this.createLogForwarderLambda();
      
      // If we couldn't create the Lambda function, we can't set up the subscription
      if (logForwarderArn === null) {
        printer.log(
          `Cannot set up log subscription for ${resourceId} without a valid Lambda function. ` +
          'Falling back to polling-based logs.',
          LogLevel.WARN
        );
        return false;
      }
      
      // Create a unique filter name for this resource
      const filterName = `amplify-devtools-${resourceId}-${randomUUID().substring(0, 8)}`;
      
      // Create a subscription filter
      const cwLogsClient = new CloudWatchLogsClient();
      await cwLogsClient.send(
        new PutSubscriptionFilterCommand({
          logGroupName,
          filterName,
          filterPattern: '', // Match all logs
          destinationArn: logForwarderArn
        })
      );
      
      // Store the active subscription
      this.activeSubscriptions.add(`${logGroupName}:${filterName}`);
      
      printer.log(`Set up log subscription for ${resourceId}`, LogLevel.INFO);
      return true;
    } catch (error) {
      printer.log(`Error setting up log subscription: ${error}`, LogLevel.ERROR);
      return false;
    }
  }

  /**
   * Removes a subscription filter for a log group
   */
  public async removeLogSubscription(logGroupName: string, resourceId: string): Promise<boolean> {
    try {
      const cwLogsClient = new CloudWatchLogsClient();
      
      // Find the filter name for this resource
      const filterPrefix = `amplify-devtools-${resourceId}`;
      let filterToRemove = null;
      
      for (const subscription of this.activeSubscriptions) {
        const [group, filter] = subscription.split(':');
        if (group === logGroupName && filter.startsWith(filterPrefix)) {
          filterToRemove = filter;
          break;
        }
      }
      
      if (!filterToRemove) {
        printer.log(`No active subscription found for ${resourceId}`, LogLevel.INFO);
        return false;
      }
      
      // Delete the subscription filter
      await cwLogsClient.send(
        new DeleteSubscriptionFilterCommand({
          logGroupName,
          filterName: filterToRemove
        })
      );
      
      // Remove from active subscriptions
      this.activeSubscriptions.delete(`${logGroupName}:${filterToRemove}`);
      
      printer.log(`Removed log subscription for ${resourceId}`, LogLevel.INFO);
      return true;
    } catch (error) {
      printer.log(`Error removing log subscription: ${error}`, LogLevel.ERROR);
      return false;
    }
  }

  /**
   * Cleans up all resources when shutting down
   */
  public async cleanup(): Promise<void> {
    // Clean up WebSocket server
    if (this.wsServer) {
      printer.log('Closing WebSocket server', LogLevel.INFO);
      this.wsServer.close();
      this.wsServer = null;
    }
    
    // Clean up any active subscription filters
    if (this.activeSubscriptions.size > 0) {
      printer.log(`Cleaning up ${this.activeSubscriptions.size} active subscription filters`, LogLevel.INFO);
      for (const subscription of this.activeSubscriptions) {
        const [logGroupName, filterName] = subscription.split(':');
        try {
          const cwLogsClient = new CloudWatchLogsClient();
          await cwLogsClient.send(
            new DeleteSubscriptionFilterCommand({
              logGroupName,
              filterName
            })
          );
          printer.log(`Removed subscription filter ${filterName} from ${logGroupName}`, LogLevel.DEBUG);
        } catch (error) {
          printer.log(`Error removing subscription filter: ${error}`, LogLevel.ERROR);
        }
      }
      this.activeSubscriptions.clear();
    }
  }

  /**
   * Gets the WebSocket server instance
   */
  public getWebSocketServer(): WebSocketServer | null {
    return this.wsServer;
  }

  /**
   * Gets the WebSocket port
   */
  public getWebSocketPort(): number {
    return this.wsPort;
  }

  /**
   * Gets the active subscriptions
   */
  public getActiveSubscriptions(): Set<string> {
    return this.activeSubscriptions;
  }
}
