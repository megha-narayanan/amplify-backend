import { LogLevel, printer } from '@aws-amplify/cli-core';
import { WebSocketServer, WebSocket } from 'ws';
import { networkInterfaces } from 'os';
import { randomUUID } from 'crypto';
import JSZip from 'jszip';
import { 
  CloudWatchLogsClient, 
  PutSubscriptionFilterCommand, 
  DeleteSubscriptionFilterCommand,
  DescribeLogGroupsCommand
} from '@aws-sdk/client-cloudwatch-logs';
import { 
  LambdaClient, 
  CreateFunctionCommand, 
  AddPermissionCommand, 
  GetFunctionCommand,
  ListFunctionsCommand
} from '@aws-sdk/client-lambda';
import { 
  IAMClient, 
  CreateRoleCommand, 
  PutRolePolicyCommand, 
  GetRoleCommand,
  ListRolesCommand
} from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

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
    
    printer.log('Starting log forwarder Lambda creation process', LogLevel.DEBUG);
    
    const localIp = await this.getLocalIpAddress();
    printer.log(`Local IP address for WebSocket endpoint: ${localIp || 'not found'}`, LogLevel.DEBUG);
    
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
      
      // Create a Lambda function with proper code for log forwarding
      printer.log('Creating Lambda function with log forwarding code', LogLevel.DEBUG);
      
      // Create the Lambda function code
      const lambdaCode = `const https = require('https');
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
};`;
      
      // Create a proper ZIP file
      const zip = new JSZip();
      zip.file('index.js', lambdaCode);
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      
      const createResponse = await lambdaClient.send(
        new CreateFunctionCommand({
          FunctionName: logForwarderName,
          Runtime: 'nodejs18.x',
          Role: roleArn,
          Handler: 'index.handler',
          Code: {
            ZipFile: zipBuffer
          },
          Environment: {
            Variables: {
              WEBSOCKET_ENDPOINT: `ws://${localIp}:${this.wsPort}`
            }
          },
          Timeout: 10 // 10 seconds
        })
      );
      
      // Extract account ID from the Lambda ARN
      if (!createResponse.FunctionArn) {
        throw new Error('Failed to create Lambda function: FunctionArn is undefined');
      }
      
      const arnParts = createResponse.FunctionArn.split(':');
      const region = arnParts[3];
      const accountId = arnParts[4];
      
      printer.log(`Lambda function created in region ${region} for account ${accountId}`, LogLevel.DEBUG);
      
      // Add permission for CloudWatch Logs to invoke this Lambda with specific source ARN
      // This is more specific than the generic permission and should resolve the "Could not execute the lambda function" error
      const statementId = `cloudwatch-logs-invoke-${randomUUID().substring(0, 8)}`;
      
      printer.log(`Adding permission for CloudWatch Logs to invoke Lambda with statement ID: ${statementId}`, LogLevel.DEBUG);
      printer.log(`Using source ARN pattern: arn:aws:logs:${region}:${accountId}:log-group:*`, LogLevel.DEBUG);
      
      try {
        await lambdaClient.send(
          new AddPermissionCommand({
            FunctionName: logForwarderName,
            StatementId: statementId,
            Action: 'lambda:InvokeFunction',
            Principal: 'logs.amazonaws.com',
            SourceArn: `arn:aws:logs:${region}:${accountId}:log-group:*`,
            SourceAccount: accountId
          })
        );
        printer.log('Successfully added CloudWatch Logs invoke permission to Lambda function', LogLevel.INFO);
      } catch (permError) {
        printer.log(`Error adding CloudWatch Logs permission: ${permError}`, LogLevel.ERROR);
        printer.log('Will attempt to continue despite permission error', LogLevel.WARN);
      }
      
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
      printer.log(`Setting up log subscription for ${resourceId} in log group ${logGroupName}`, LogLevel.DEBUG);
      
      // Check if log group exists first
      const cwLogsClient = new CloudWatchLogsClient();
      
      // Create or get the Lambda function
      printer.log('Creating or getting log forwarder Lambda function', LogLevel.DEBUG);
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
      
      printer.log(`Successfully obtained Lambda ARN: ${logForwarderArn}`, LogLevel.DEBUG);
      
      // Create a unique filter name for this resource
      const filterName = `amplify-devtools-${resourceId}-${randomUUID().substring(0, 8)}`;
      printer.log(`Generated filter name: ${filterName}`, LogLevel.DEBUG);
      
      // Try with a very simple filter pattern first
      printer.log('Creating subscription filter with empty pattern', LogLevel.DEBUG);
      
      try {
        // Get AWS account ID using STS for additional debugging
        const stsClient = new STSClient();
        try {
          const identityResponse = await stsClient.send(new GetCallerIdentityCommand({}));
          printer.log(`Current AWS identity: ${identityResponse.Arn}`, LogLevel.DEBUG);
          printer.log(`Current AWS account: ${identityResponse.Account}`, LogLevel.DEBUG);
        } catch (stsError) {
          printer.log(`Error getting AWS identity: ${stsError}`, LogLevel.WARN);
        }
        
        // Create a subscription filter
        printer.log(`Creating subscription filter with name ${filterName} for log group ${logGroupName}`, LogLevel.DEBUG);
        printer.log(`Using destination ARN: ${logForwarderArn}`, LogLevel.DEBUG);
        
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
        
        printer.log(`Successfully set up log subscription for ${resourceId}`, LogLevel.INFO);
        return true;
      } catch (error) {
        const subscriptionError = error as Error;
        printer.log(`Error creating subscription filter: ${subscriptionError}`, LogLevel.ERROR);
        
        // Check if this is a permissions issue
        if (subscriptionError.toString().includes('AccessDenied')) {
          printer.log('This appears to be a permissions issue. Make sure your AWS credentials have sufficient permissions.', LogLevel.ERROR);
        }
        
        // Try to get more information about the Lambda function
        try {
          const lambdaClient = new LambdaClient();
          const lambdaInfo = await lambdaClient.send(
            new GetFunctionCommand({ FunctionName: 'amplify-devtools-log-forwarder' })
          );
          printer.log(`Lambda function exists with state: ${lambdaInfo.Configuration?.State}`, LogLevel.DEBUG);
          
          // Print more details about the Lambda function
          printer.log(`Lambda function ARN: ${lambdaInfo.Configuration?.FunctionArn}`, LogLevel.DEBUG);
          printer.log(`Lambda function role: ${lambdaInfo.Configuration?.Role}`, LogLevel.DEBUG);
          
          // Try to get the policy - using GetPolicy command instead of direct object
          try {
            // Import the GetPolicy command dynamically to avoid TypeScript errors
            const { GetPolicyCommand } = await import('@aws-sdk/client-lambda');
            const policyResponse = await lambdaClient.send(
              new GetPolicyCommand({
                FunctionName: 'amplify-devtools-log-forwarder'
              })
            );
            printer.log(`Lambda policy: ${JSON.stringify(policyResponse)}`, LogLevel.DEBUG);
          } catch (policyError) {
            printer.log(`Error getting Lambda policy: ${policyError}`, LogLevel.DEBUG);
          }
        } catch (lambdaError) {
          printer.log(`Error checking Lambda function: ${lambdaError}`, LogLevel.ERROR);
        }
        
        throw subscriptionError; // Re-throw to be caught by outer catch
      }
    } catch (error) {
      // Provide more detailed error information
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : '';
      
      printer.log(`Error setting up log subscription: ${errorMessage}`, LogLevel.ERROR);
      if (errorStack) {
        printer.log(`Error stack: ${errorStack}`, LogLevel.DEBUG);
      }
      
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
  
  /**
   * Runs diagnostics to check AWS service health and permissions
   * This can be called to help diagnose issues with log subscriptions
   */
  public async runDiagnostics(): Promise<Record<string, any>> {
    const results: Record<string, any> = {};
    
    printer.log('Running AWS service diagnostics', LogLevel.INFO);
    
    // Check Lambda service
    try {
      const lambdaClient = new LambdaClient();
      const region = lambdaClient.config.region;
      results.lambdaRegion = region;
      
      printer.log(`Using AWS region: ${region}`, LogLevel.INFO);
      
      // Try to list Lambda functions
      const listFunctionsResponse = await lambdaClient.send(
        new ListFunctionsCommand({
          MaxItems: 1
        })
      );
      
      results.lambdaServiceAccessible = true;
      printer.log('Successfully connected to Lambda service', LogLevel.INFO);
    } catch (error) {
      results.lambdaServiceAccessible = false;
      results.lambdaError = String(error);
      printer.log(`Error connecting to Lambda service: ${error}`, LogLevel.ERROR);
    }
    
    // Check CloudWatch Logs service
    try {
      const cwLogsClient = new CloudWatchLogsClient();
      
      // Try to describe log groups
      const describeLogGroupsResponse = await cwLogsClient.send(
        new DescribeLogGroupsCommand({
          limit: 1
        })
      );
      
      results.cloudWatchLogsServiceAccessible = true;
      printer.log('Successfully connected to CloudWatch Logs service', LogLevel.INFO);
    } catch (error) {
      results.cloudWatchLogsServiceAccessible = false;
      results.cloudWatchLogsError = String(error);
      printer.log(`Error connecting to CloudWatch Logs service: ${error}`, LogLevel.ERROR);
    }
    
    // Check IAM service
    try {
      const iamClient = new IAMClient();
      
      // Try to list roles
      const listRolesResponse = await iamClient.send(
        new ListRolesCommand({
          MaxItems: 1
        })
      );
      
      results.iamServiceAccessible = true;
      printer.log('Successfully connected to IAM service', LogLevel.INFO);
    } catch (error) {
      results.iamServiceAccessible = false;
      results.iamError = String(error);
      printer.log(`Error connecting to IAM service: ${error}`, LogLevel.ERROR);
    }
    
    return results;
  }
}
