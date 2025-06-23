import { LogLevel, printer } from '@aws-amplify/cli-core';
import { DeployedBackendClientFactory } from '@aws-amplify/deployed-backend-client';
import { S3Client } from '@aws-sdk/client-s3';
import { AmplifyClient } from '@aws-sdk/client-amplify';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { LocalStorageManager } from '../local_storage_manager.js';
import { createFriendlyName } from '../utils/cloudformation_utils.js';

/**
 * Type for a resource with friendly name
 */
export type ResourceWithFriendlyName = {
  logicalResourceId: string;
  physicalResourceId: string;
  resourceType: string;
  resourceStatus: string;
  friendlyName?: string;
};

/**
 * Service for managing backend resources
 */
export class ResourceService {
  private backendClient: any; // Using any for now, should be replaced with proper type
  private storageManager: LocalStorageManager;
  private backendId: { name: string };
  private getSandboxState: () => string;

  /**
   * Creates a new ResourceService
   */
  constructor(
    storageManager: LocalStorageManager,
    backendId: { name: string },
    getSandboxState: () => string
  ) {
    this.storageManager = storageManager;
    this.backendId = backendId;
    this.getSandboxState = getSandboxState;
    
    // Initialize the backend client
    this.backendClient = new DeployedBackendClientFactory().getInstance({
      getS3Client: () => new S3Client(),
      getAmplifyClient: () => new AmplifyClient(),
      getCloudFormationClient: () => new CloudFormationClient(),
    });
  }

  /**
   * Gets the deployed backend resources
   * @returns The deployed backend resources with friendly names
   */
  public async getDeployedBackendResources(): Promise<any> {
    try {
      // Try to load saved resources first
      const savedResources = this.storageManager.loadResources();
      if (savedResources) {
        printer.log('Found saved resources, returning them', LogLevel.INFO);
        const status = this.getSandboxState();
        return {
          ...savedResources,
          status
        };
      }
      
      try {
        printer.log('Fetching backend metadata...', LogLevel.DEBUG);
        const data = await this.backendClient.getBackendMetadata(this.backendId);
        printer.log('Successfully fetched backend metadata', LogLevel.DEBUG);

        // Get the AWS region from the CloudFormation client
        const cfnClient = new CloudFormationClient();
        const regionValue = cfnClient.config.region;

        // Handle different types of region values
        let region = null;

        try {
          if (typeof regionValue === 'function') {
            // If it's an async function, we need to await it
            if (regionValue.constructor.name === 'AsyncFunction') {
              region = await regionValue();
            } else {
              region = regionValue();
            }
          } else if (regionValue) {
            region = String(regionValue);
          }

          // Final check to ensure region is a string
          if (region && typeof region !== 'string') {
            region = String(region);
          }
        } catch (error) {
          printer.log('Error processing region: ' + error, LogLevel.ERROR);
          region = null;
        }

        // Process resources and add friendly names
        const resourcesWithFriendlyNames = data.resources.map((resource: any) => {
          const logicalId = resource.logicalResourceId || '';
          let resourceType = resource.resourceType || '';
          
          // Remove CUSTOM:: prefix from resource type
          if (resourceType.startsWith('CUSTOM::')) {
            resourceType = resourceType.substring(8); // Remove "CUSTOM::" (8 characters)
          } else if (resourceType.startsWith('Custom::')) {
            resourceType = resourceType.substring(8); // Remove "Custom::" (8 characters)
          }
          
          // Check if the resource has metadata with a construct path
          // Use a type guard to check if the resource has a metadata property
          const metadata = 'metadata' in resource && 
                          typeof resource.metadata === 'object' && 
                          resource.metadata !== null && 
                          'constructPath' in resource.metadata ? { 
            constructPath: resource.metadata.constructPath as string
          } : undefined;
          
          return {
            ...resource,
            resourceType: resourceType,
            friendlyName: createFriendlyName(logicalId, metadata),
          } as ResourceWithFriendlyName;
        });

        // Add region and resources with friendly names to the data
        const enhancedData = {
          ...data,
          region,
          resources: resourcesWithFriendlyNames,
        };
        
        // Save resources to local storage for persistence
        this.storageManager.saveResources(enhancedData);

        return enhancedData;
      } catch (error) {
        const errorMessage = String(error);
        printer.log(
          `Error getting backend resources: ${errorMessage}`,
          LogLevel.ERROR,
        );
        
        // Check if this is a deployment in progress error
        if (errorMessage.includes('deployment is in progress')) {
          return {
            name: this.backendId.name,
            status: 'deploying',
            resources: [],
            region: null,
            message: 'Sandbox deployment is in progress. Resources will update when deployment completes.'
          };
        } else if (errorMessage.includes('does not exist')) {
          // If the stack doesn't exist, return empty resources
          return {
            name: this.backendId.name,
            status: 'nonexistent',
            resources: [],
            region: null,
            message: 'No sandbox exists. Please create a sandbox first.'
          };
        } else {
          // For other errors, throw the error
          throw error;
        }
      }
    } catch (error) {
      printer.log(
        `Error checking sandbox status: ${error}`,
        LogLevel.ERROR,
      );
      throw error;
    }
  }
}
